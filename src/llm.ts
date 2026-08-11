import type { Config, ProviderConfig } from "./config.ts";
import { getSecret, routeFor } from "./config.ts";
import { MengError, EXIT } from "./errors.ts";
import type { ToolDef } from "./tools.ts";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface LlmReply {
  text: string;
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  stopReason: string;
}

export interface AttemptLog {
  attempt: number;
  status?: number;
  error: string;
  waitMs: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function backoff(attempt: number): number {
  const base = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
  return base + Math.random() * base * 0.3;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------- wire formats

function toOpenAI(messages: Message[], tools: ToolDef[], model: string) {
  return {
    model,
    messages: messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
      }
      if (m.tool_calls?.length) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.tool_calls.map((t) => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          })),
        };
      }
      return { role: m.role, content: m.content };
    }),
    tools: tools.length
      ? tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined,
    tool_choice: tools.length ? "auto" : undefined,
  };
}

function toAnthropic(messages: Message[], tools: ToolDef[], model: string) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");

  const converted: Array<{ role: string; content: unknown }> = [];
  for (const m of rest) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content };
      const last = converted.at(-1);
      // Anthropic requires tool_result blocks to be batched in one user turn.
      if (last?.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else converted.push({ role: "user", content: [block] });
      continue;
    }
    if (m.tool_calls?.length) {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const t of m.tool_calls) {
        blocks.push({ type: "tool_use", id: t.id, name: t.name, input: t.args });
      }
      converted.push({ role: "assistant", content: blocks });
      continue;
    }
    converted.push({ role: m.role, content: m.content });
  }

  return {
    model,
    max_tokens: 8192,
    system: system || undefined,
    messages: converted,
    tools: tools.length
      ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      : undefined,
  };
}

function parseOpenAI(body: any): LlmReply {
  const choice = body.choices?.[0];
  const msg = choice?.message ?? {};
  const calls: ToolCall[] = (msg.tool_calls ?? []).map((t: any) => {
    let args: unknown = {};
    try {
      args = JSON.parse(t.function?.arguments || "{}");
    } catch {
      args = { __parse_error: t.function?.arguments };
    }
    return { id: t.id, name: t.function?.name, args };
  });
  return {
    text: msg.content ?? "",
    toolCalls: calls,
    tokensIn: body.usage?.prompt_tokens ?? 0,
    tokensOut: body.usage?.completion_tokens ?? 0,
    stopReason: choice?.finish_reason ?? "stop",
  };
}

function parseAnthropic(body: any): LlmReply {
  const blocks = body.content ?? [];
  const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const calls: ToolCall[] = blocks
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
  return {
    text,
    toolCalls: calls,
    tokensIn: body.usage?.input_tokens ?? 0,
    tokensOut: body.usage?.output_tokens ?? 0,
    stopReason: body.stop_reason ?? "end_turn",
  };
}

// ------------------------------------------------------------------ request

export interface CallOptions {
  cfg: Config;
  team: string;
  messages: Message[];
  tools: ToolDef[];
  onAttempt?(log: AttemptLog): void;
}

export async function callLlm(opts: CallOptions): Promise<LlmReply> {
  const { provider, model } = routeFor(opts.cfg, opts.team);
  const key = await getSecret(provider.secret_ref);
  if (!key) {
    throw new MengError(
      `no API key stored for "${provider.secret_ref}"`,
      EXIT.BAD_CONFIG,
      "run: mengcli config",
    );
  }

  const anthropic = provider.api === "anthropic";
  const url = anthropic
    ? joinUrl(provider.base_url, "/v1/messages")
    : joinUrl(provider.base_url, "/chat/completions");

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (anthropic) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${key}`;
  }

  const payload = anthropic
    ? toAnthropic(opts.messages, opts.tools, model)
    : toOpenAI(opts.messages, opts.tools, model);

  let lastError = "unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.cfg.timeouts.llm_request_seconds * 1000),
      });

      if (res.ok) {
        const body = await res.json();
        return anthropic ? parseAnthropic(body) : parseOpenAI(body);
      }

      const text = (await res.text()).slice(0, 500);
      lastError = `HTTP ${res.status}: ${text}`;

      if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
        throw new MengError(`LLM request failed — ${lastError}`);
      }

      // Honour Retry-After when the server provides a sane value.
      const ra = Number(res.headers.get("retry-after"));
      const wait =
        Number.isFinite(ra) && ra >= 0 && ra <= 300 ? ra * 1000 : backoff(attempt);
      opts.onAttempt?.({ attempt, status: res.status, error: lastError, waitMs: wait });
      await sleep(wait);
    } catch (e) {
      if (e instanceof MengError) throw e;
      lastError = (e as Error).message;
      if (attempt === MAX_ATTEMPTS) {
        throw new MengError(`LLM request failed after ${MAX_ATTEMPTS} attempts — ${lastError}`);
      }
      const wait = backoff(attempt);
      opts.onAttempt?.({ attempt, error: lastError, waitMs: wait });
      await sleep(wait);
    }
  }

  throw new MengError(`LLM request failed — ${lastError}`);
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  // Tolerate base URLs that already carry the version segment.
  if (b.endsWith("/v1") && path.startsWith("/v1/")) return b + path.slice(3);
  return b + path;
}

export async function probeProvider(provider: ProviderConfig, model: string): Promise<string | null> {
  const key = await getSecret(provider.secret_ref);
  if (!key) return "no API key stored";
  try {
    const anthropic = provider.api === "anthropic";
    const url = anthropic
      ? joinUrl(provider.base_url, "/v1/messages")
      : joinUrl(provider.base_url, "/chat/completions");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (anthropic) {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else headers["authorization"] = `Bearer ${key}`;

    const body = anthropic
      ? { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }
      : { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return null;
    return `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
  } catch (e) {
    return (e as Error).message;
  }
}

export { joinUrl };
