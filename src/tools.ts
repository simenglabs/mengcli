import { z } from "zod";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { dirname, relative } from "path";
import type { Config } from "./config.ts";
import { run, safePath } from "./git.ts";
import { MengError } from "./errors.ts";

export interface ToolCtx {
  worktree: string;
  cfg: Config;
  /** Files this agent already holds locks for; write is denied otherwise. */
  locked: Set<string>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /** JSON Schema handed to the LLM. */
  parameters: Record<string, unknown>;
  /** Files this call intends to write, for up-front lock declaration. */
  writes?(args: never): string[];
  exec(args: never, ctx: ToolCtx): Promise<ToolResult>;
}

const MAX_OUTPUT = 30_000;

const clip = (s: string) =>
  s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n... [truncated ${s.length - MAX_OUTPUT} chars]` : s;

// ------------------------------------------------------------------ read

const ReadArgs = z.object({
  path: z.string().min(1),
  max_lines: z.number().int().positive().max(2000).default(400),
});

const readFileTool: ToolDef = {
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace.",
  schema: ReadArgs,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root" },
      max_lines: { type: "number", description: "Maximum lines to return (default 400)" },
    },
    required: ["path"],
  },
  async exec(args: z.infer<typeof ReadArgs>, ctx) {
    const abs = safePath(ctx.worktree, args.path);
    const f = Bun.file(abs);
    if (!(await f.exists())) return { ok: false, output: `no such file: ${args.path}` };
    const lines = (await f.text()).split("\n");
    const head = lines.slice(0, args.max_lines);
    const numbered = head.map((l, i) => `${i + 1}: ${l}`).join("\n");
    const more = lines.length > head.length ? `\n... ${lines.length - head.length} more lines` : "";
    return { ok: true, output: clip(numbered + more) };
  },
};

// ----------------------------------------------------------------- write

const WriteArgs = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const writeFileTool: ToolDef = {
  name: "write_file",
  description: "Create or overwrite a file in the workspace. Requires a held lock.",
  schema: WriteArgs,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root" },
      content: { type: "string", description: "Full file contents" },
    },
    required: ["path", "content"],
  },
  writes: (args: z.infer<typeof WriteArgs>) => [args.path],
  async exec(args: z.infer<typeof WriteArgs>, ctx) {
    const abs = safePath(ctx.worktree, args.path);
    const rel = relative(ctx.worktree, abs);
    if (!ctx.locked.has(rel)) {
      return { ok: false, output: `no lock held for ${rel}; declare it before writing` };
    }
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, args.content);
    return { ok: true, output: `wrote ${rel} (${args.content.length} bytes)` };
  },
};

// ------------------------------------------------------------------ edit

const EditArgs = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
});

const editFileTool: ToolDef = {
  name: "edit_file",
  description: "Replace an exact unique substring in a file. Requires a held lock.",
  schema: EditArgs,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace; must occur exactly once" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  writes: (args: z.infer<typeof EditArgs>) => [args.path],
  async exec(args: z.infer<typeof EditArgs>, ctx) {
    const abs = safePath(ctx.worktree, args.path);
    const rel = relative(ctx.worktree, abs);
    if (!ctx.locked.has(rel)) {
      return { ok: false, output: `no lock held for ${rel}; declare it before writing` };
    }
    const f = Bun.file(abs);
    if (!(await f.exists())) return { ok: false, output: `no such file: ${rel}` };
    const body = await f.text();
    const n = body.split(args.old_string).length - 1;
    if (n === 0) return { ok: false, output: `old_string not found in ${rel}` };
    if (n > 1) return { ok: false, output: `old_string occurs ${n} times in ${rel}; make it unique` };
    await Bun.write(abs, body.replace(args.old_string, args.new_string));
    return { ok: true, output: `edited ${rel}` };
  },
};

// ------------------------------------------------------------------ list

const ListArgs = z.object({
  pattern: z.string().default("**/*"),
  limit: z.number().int().positive().max(500).default(200),
});

const listFilesTool: ToolDef = {
  name: "list_files",
  description: "List workspace files matching a glob pattern.",
  schema: ListArgs,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob, e.g. src/**/*.ts" },
      limit: { type: "number" },
    },
    required: [],
  },
  async exec(args: z.infer<typeof ListArgs>, ctx) {
    const glob = new Bun.Glob(args.pattern);
    const out: string[] = [];
    for await (const f of glob.scan({ cwd: ctx.worktree, dot: false })) {
      if (f.startsWith(".git/") || f.includes("node_modules/")) continue;
      out.push(f);
      if (out.length >= args.limit) break;
    }
    return { ok: true, output: out.length ? out.sort().join("\n") : "(no matches)" };
  },
};

// ---------------------------------------------------------------- search

const SearchArgs = z.object({
  query: z.string().min(1),
  glob: z.string().optional(),
  limit: z.number().int().positive().max(200).default(60),
});

const searchTool: ToolDef = {
  name: "search",
  description: "Search file contents by regular expression.",
  schema: SearchArgs,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Regular expression" },
      glob: { type: "string", description: "Optional file filter, e.g. *.ts" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
  async exec(args: z.infer<typeof SearchArgs>, ctx) {
    if (Bun.which("rg")) {
      const cmd = ["rg", "--line-number", "--no-heading", "--color=never", "-m", String(args.limit)];
      if (args.glob) cmd.push("--glob", args.glob);
      cmd.push("--", args.query);
      const r = await run(cmd, ctx.worktree, 30_000);
      if (r.code === 1) return { ok: true, output: "(no matches)" };
      if (!r.ok) return { ok: false, output: r.stderr || "search failed" };
      return { ok: true, output: clip(r.stdout) };
    }
    // Fallback when ripgrep is absent: slower, but keeps the team working.
    let re: RegExp;
    try {
      re = new RegExp(args.query);
    } catch (e) {
      return { ok: false, output: `invalid regex: ${(e as Error).message}` };
    }
    const glob = new Bun.Glob(args.glob ?? "**/*");
    const hits: string[] = [];
    for await (const rel of glob.scan({ cwd: ctx.worktree })) {
      if (rel.startsWith(".git/") || rel.includes("node_modules/")) continue;
      let text: string;
      try {
        text = await Bun.file(`${ctx.worktree}/${rel}`).text();
      } catch {
        continue; // binary or unreadable
      }
      text.split("\n").forEach((line, i) => {
        if (hits.length < args.limit && re.test(line)) hits.push(`${rel}:${i + 1}:${line.trim()}`);
      });
      if (hits.length >= args.limit) break;
    }
    return { ok: true, output: hits.length ? clip(hits.join("\n")) : "(no matches)" };
  },
};

// ------------------------------------------------------------------ bash

const BashArgs = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().int().positive().max(600).optional(),
});

/** Deny anything that reaches the network or escapes the sandbox. */
const HARD_DENY = [
  /\brm\s+-rf?\s+[~/]/,
  /\b(curl|wget|nc|ncat|ssh|scp|telnet)\b/,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /:\(\)\s*\{.*\}\s*;/, // fork bomb
  />\s*\/dev\/(sd|nvme|disk)/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
];

export function checkCommand(
  command: string,
  cfg: Config,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = command.trim();
  for (const re of HARD_DENY) {
    if (re.test(trimmed)) return { ok: false, reason: `command matches a hard deny rule: ${re}` };
  }
  // Every segment of a pipeline or chain is checked, not just the first.
  const segments = trimmed.split(/(?:&&|\|\||;|\|)/g).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const bin = seg.split(/\s+/)[0]!.replace(/^.*\//, "");
    if (!cfg.tools.allowed.includes(bin)) {
      return { ok: false, reason: `"${bin}" is not in tools.allowed` };
    }
    const denied = cfg.tools.denied_args[bin] ?? [];
    const rest = seg.slice(seg.indexOf(bin) + bin.length).trim();
    for (const d of denied) {
      if (rest.startsWith(d) || rest.includes(` ${d}`)) {
        return { ok: false, reason: `"${bin} ${d}" is denied` };
      }
    }
  }
  return { ok: true };
}

const bashTool: ToolDef = {
  name: "bash",
  description: "Run an allowlisted shell command inside the workspace.",
  schema: BashArgs,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command line to execute" },
      timeout_seconds: { type: "number" },
    },
    required: ["command"],
  },
  async exec(args: z.infer<typeof BashArgs>, ctx) {
    const check = checkCommand(args.command, ctx.cfg);
    if (!check.ok) return { ok: false, output: `denied: ${check.reason}` };
    const timeout = (args.timeout_seconds ?? ctx.cfg.timeouts.tool_call_seconds) * 1000;
    const r = await run(["sh", "-c", args.command], ctx.worktree, timeout);
    const body = [r.stdout, r.stderr].filter(Boolean).join("\n");
    return { ok: r.ok, output: clip(body || `(exit ${r.code}, no output)`) };
  },
};

// ------------------------------------------------------------- completion

const DoneArgs = z.object({
  summary: z.string().min(1),
  files_changed: z.array(z.string()).default([]),
});

const doneTool: ToolDef = {
  name: "task_done",
  description: "Declare the assigned work finished and hand back a summary.",
  schema: DoneArgs,
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "What was accomplished" },
      files_changed: { type: "array", items: { type: "string" } },
    },
    required: ["summary"],
  },
  async exec(args: z.infer<typeof DoneArgs>) {
    return { ok: true, output: `done: ${args.summary}` };
  },
};

const AskArgs = z.object({ question: z.string().min(1) });

const askTool: ToolDef = {
  name: "ask_user",
  description: "Pause and ask the user a clarifying question. Use only when genuinely blocked.",
  schema: AskArgs,
  parameters: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
  async exec(args: z.infer<typeof AskArgs>) {
    return { ok: true, output: `paused: ${args.question}` };
  },
};

// ------------------------------------------------------------------ registry

export const ALL_TOOLS: Record<string, ToolDef> = Object.fromEntries(
  [readFileTool, writeFileTool, editFileTool, listFilesTool, searchTool, bashTool, doneTool, askTool].map(
    (t) => [t.name, t],
  ),
);

export const TEAM_TOOLS: Record<string, string[]> = {
  planner: ["read_file", "list_files", "search", "task_done", "ask_user"],
  riset: ["read_file", "list_files", "search", "bash", "task_done"],
  dev: ["read_file", "write_file", "edit_file", "list_files", "search", "bash", "task_done", "ask_user"],
};

export function toolsFor(team: string): ToolDef[] {
  const names = TEAM_TOOLS[team] ?? TEAM_TOOLS.dev!;
  return names.map((n) => ALL_TOOLS[n]!).filter(Boolean);
}

/**
 * Validate LLM-produced arguments before execution. Malformed arguments are a
 * normal occurrence, so the error text is fed back for a single reprompt.
 */
export async function execTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolCtx,
): Promise<ToolResult> {
  const tool = ALL_TOOLS[name];
  if (!tool) return { ok: false, output: `unknown tool: ${name}` };
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { ok: false, output: `invalid arguments for ${name}: ${detail}` };
  }
  try {
    return await tool.exec(parsed.data as never, ctx);
  } catch (e) {
    if (e instanceof MengError) return { ok: false, output: e.message };
    return { ok: false, output: `${name} failed: ${(e as Error).message}` };
  }
}

/** Files a tool call intends to write, used for up-front lock declaration. */
export function declaredWrites(name: string, rawArgs: unknown): string[] {
  const tool = ALL_TOOLS[name];
  if (!tool?.writes) return [];
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) return [];
  return tool.writes(parsed.data as never);
}

export { existsSync };
