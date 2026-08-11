import { existsSync } from "fs";
import { join } from "path";
import type { Config } from "./config.ts";
import { SKILLS_DIR } from "./paths.ts";
import { callLlm, type Message, type ToolCall } from "./llm.ts";
import { execTool, declaredWrites, toolsFor, type ToolCtx } from "./tools.ts";
import {
  acquireLocks,
  chargeTokens,
  dayTokens,
  getTask,
  logEvent,
  lockBackoff,
  releaseLocks,
} from "./db.ts";
import { budgetExceeded, MengError } from "./errors.ts";

export type Team = "planner" | "riset" | "dev";

export const BUILTIN_SKILLS: Record<Team, string> = {
  planner: `# Team Planner

You are the architect. You do not write code.

Your job:
1. Read enough of the codebase to understand the request in context.
2. Produce a concrete, ordered plan of file-level changes.
3. Call task_done with the plan as the summary.

Rules:
- Be specific: name the files to create or modify and what changes each needs.
- Keep the plan to at most 8 steps. Prefer the smallest change that satisfies the request.
- Do not propose refactors, abstractions, or tests that were not requested.
- If the request is genuinely ambiguous and a wrong guess would waste real work,
  call ask_user once with a precise question. Otherwise pick a sensible default and proceed.`,

  riset: `# Team Riset

You are the code explorer. You do not write code.

Your job:
1. Locate the files and symbols relevant to the plan.
2. Report exact paths, line numbers, and existing patterns worth following.
3. Call task_done with the findings as the summary.

Rules:
- Prefer search and list_files over reading whole files.
- Report what exists, not what should change.
- Note the project's conventions: language, test runner, formatting, module style.`,

  dev: `# Team Dev

You are the implementer. You write the code.

Your job:
1. Apply the plan using write_file and edit_file.
2. Verify your work when a test or build command is available.
3. Call task_done with a summary of what changed.

Rules:
- Read a file before editing it.
- Make the smallest change that satisfies the request. No unrequested abstractions,
  no scaffolding for hypothetical future needs.
- Follow the conventions already present in the codebase.
- Never invent a dependency that is not already in the project.
- If a command fails, read the error and fix it rather than working around it.
- Call task_done as soon as the work is complete. Do not keep polishing.`,
};

/** User-authored skills at ~/.config/mengcli/skills/<team>/SKILL.md win. */
export async function loadSkill(team: Team): Promise<string> {
  const path = join(SKILLS_DIR, team, "SKILL.md");
  if (existsSync(path)) {
    const custom = (await Bun.file(path).text()).trim();
    if (custom) return custom;
  }
  return BUILTIN_SKILLS[team];
}

export interface AgentInput {
  taskId: string;
  team: Team;
  cfg: Config;
  worktree: string;
  /** Instruction for this team, usually built from prior teams' output. */
  brief: string;
  onEvent?(line: string): void;
}

export interface AgentOutput {
  status: "done" | "paused" | "budget" | "stalled";
  summary: string;
  question?: string;
  filesChanged: string[];
}

const MAX_TOOLS_PER_TURN = 8;

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const { taskId, team, cfg, worktree } = input;
  const tools = toolsFor(team);
  const skill = await loadSkill(team);
  const locked = new Set<string>();
  const filesChanged = new Set<string>();
  const say = input.onEvent ?? (() => {});

  const ctx: ToolCtx = { worktree, cfg, locked };

  const messages: Message[] = [
    {
      role: "system",
      content:
        `${skill}\n\n` +
        `Workspace root: ${worktree}\n` +
        `All paths are relative to the workspace root.\n` +
        `Allowed shell commands: ${cfg.tools.allowed.join(", ")}\n` +
        `You must finish by calling task_done. Do not reply with prose alone.`,
    },
    { role: "user", content: input.brief },
  ];

  logEvent(taskId, { kind: "team.handoff", team, summary: input.brief.slice(0, 300) });
  say(`▶ ${team} started`);

  for (let iteration = 1; iteration <= cfg.budget.max_iterations_per_task; iteration++) {
    // --- budget check before spending, not after
    const task = getTask(taskId)!;
    if (task.tokens_used >= cfg.budget.max_tokens_per_task) {
      logEvent(taskId, {
        kind: "budget.exceeded",
        team,
        summary: `task budget ${task.tokens_used}/${cfg.budget.max_tokens_per_task} tokens`,
      });
      releaseLocks(taskId, team);
      return { status: "budget", summary: "task token budget exhausted", filesChanged: [...filesChanged] };
    }
    if (dayTokens() >= cfg.budget.max_tokens_per_day) {
      logEvent(taskId, {
        kind: "budget.exceeded",
        team,
        summary: `daily budget ${dayTokens()}/${cfg.budget.max_tokens_per_day} tokens`,
      });
      releaseLocks(taskId, team);
      throw budgetExceeded("daily token budget exhausted");
    }

    const started = Date.now();
    logEvent(taskId, { kind: "llm.request", team, summary: `iteration ${iteration}` });

    let reply;
    try {
      reply = await callLlm({
        cfg,
        team,
        messages,
        tools,
        onAttempt: (a) => {
          logEvent(taskId, {
            kind: "llm.error",
            team,
            summary: `attempt ${a.attempt} failed, retrying in ${Math.round(a.waitMs)}ms`,
            payload: { status: a.status, error: a.error },
          });
          say(`  ⟳ retry ${a.attempt}: ${a.error.slice(0, 80)}`);
        },
      });
    } catch (e) {
      logEvent(taskId, { kind: "llm.error", team, summary: (e as Error).message });
      releaseLocks(taskId, team);
      throw e;
    }

    // Every attempt is charged, including retries, so retries cannot leak cost.
    const spend = chargeTokens(taskId, reply.tokensIn + reply.tokensOut, 1);
    logEvent(taskId, {
      kind: "llm.response",
      team,
      summary: reply.text.slice(0, 300) || `${reply.toolCalls.length} tool call(s)`,
      tokensIn: reply.tokensIn,
      tokensOut: reply.tokensOut,
      durationMs: Date.now() - started,
    });

    const pct = Math.round((spend.taskTokens / cfg.budget.max_tokens_per_task) * 100);
    if (pct >= 80) {
      logEvent(taskId, { kind: "budget.warning", team, summary: `${pct}% of task budget used` });
      say(`  ⚠ budget ${pct}%`);
    }

    if (reply.text.trim()) say(`  ${reply.text.trim().slice(0, 200)}`);

    if (reply.toolCalls.length === 0) {
      // No tool call and no completion: nudge once, then treat as stalled.
      messages.push({ role: "assistant", content: reply.text });
      messages.push({
        role: "user",
        content: "You must call a tool. Call task_done if the work is complete.",
      });
      continue;
    }

    const calls = reply.toolCalls.slice(0, MAX_TOOLS_PER_TURN);
    messages.push({ role: "assistant", content: reply.text, tool_calls: calls });

    // --- lock every file this turn intends to write, all-or-nothing
    const wants = calls.flatMap((c) => declaredWrites(c.name, c.args));
    const missing = [...new Set(wants)].filter((p) => !locked.has(p));
    if (missing.length) {
      const got = await acquireWithBackoff(taskId, team, [...locked, ...missing], cfg);
      if (!got) {
        releaseLocks(taskId, team);
        return {
          status: "stalled",
          summary: `could not acquire file locks for: ${missing.join(", ")}`,
          filesChanged: [...filesChanged],
        };
      }
      missing.forEach((p) => locked.add(p));
    }

    let finished: AgentOutput | null = null;

    for (const call of calls) {
      logEvent(taskId, {
        kind: "tool.call",
        team,
        summary: `${call.name} ${describeArgs(call)}`,
        payload: call.args,
      });
      say(`  ⚙ ${call.name} ${describeArgs(call)}`);

      if (call.name === "task_done") {
        const a = call.args as { summary?: string; files_changed?: string[] };
        (a.files_changed ?? []).forEach((f) => filesChanged.add(f));
        finished = {
          status: "done",
          summary: a.summary ?? "completed",
          filesChanged: [...filesChanged],
        };
        messages.push({ role: "tool", tool_call_id: call.id, content: "acknowledged" });
        break;
      }

      if (call.name === "ask_user") {
        const a = call.args as { question?: string };
        logEvent(taskId, { kind: "pause.requested", team, summary: a.question ?? "" });
        finished = {
          status: "paused",
          summary: "waiting for user input",
          question: a.question ?? "(no question provided)",
          filesChanged: [...filesChanged],
        };
        messages.push({ role: "tool", tool_call_id: call.id, content: "acknowledged" });
        break;
      }

      const res = await execTool(call.name, call.args, ctx);
      logEvent(taskId, {
        kind: res.ok ? "tool.result" : "tool.denied",
        team,
        summary: `${call.name}: ${res.output.slice(0, 200)}`,
      });
      if (res.ok && (call.name === "write_file" || call.name === "edit_file")) {
        filesChanged.add((call.args as { path: string }).path);
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: res.ok ? res.output : `ERROR: ${res.output}`,
      });
    }

    if (finished) {
      releaseLocks(taskId, team);
      say(`✔ ${team} ${finished.status}`);
      return finished;
    }
  }

  releaseLocks(taskId, team);
  logEvent(taskId, {
    kind: "circuit_breaker.tripped",
    team,
    summary: `hit ${cfg.budget.max_iterations_per_task} iterations without completing`,
  });
  return {
    status: "stalled",
    summary: `${team} hit the iteration limit without calling task_done`,
    filesChanged: [...filesChanged],
  };
}

/**
 * Retry the all-or-nothing acquisition with jittered backoff. Because locks are
 * taken sorted and released wholesale on failure, there is no hold-and-wait and
 * therefore no deadlock to detect.
 */
async function acquireWithBackoff(
  taskId: string,
  team: string,
  files: string[],
  cfg: Config,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = acquireLocks(taskId, team, files, cfg.timeouts.file_lock_seconds);
    if (r.ok) return true;
    await new Promise((res) => setTimeout(res, lockBackoff(attempt)));
  }
  return false;
}

function describeArgs(call: ToolCall): string {
  const a = call.args as Record<string, unknown>;
  if (typeof a?.path === "string") return a.path;
  if (typeof a?.command === "string") return `\`${a.command.slice(0, 60)}\``;
  if (typeof a?.query === "string") return `/${a.query.slice(0, 40)}/`;
  if (typeof a?.pattern === "string") return a.pattern;
  if (typeof a?.question === "string") return a.question.slice(0, 80);
  if (typeof a?.summary === "string") return a.summary.slice(0, 80);
  return "";
}

export { MengError };
