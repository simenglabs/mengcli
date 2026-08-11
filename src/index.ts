#!/usr/bin/env bun
import { rm } from "fs/promises";
import { existsSync } from "fs";
import { CONFIG_FILE, DB_FILE, ensureDirs, taskWorktree, workspaceDir } from "./paths.ts";
import { EXIT, MengError, notFound } from "./errors.ts";
import { BANNER, ago, c, fail, info, table, warn } from "./ui.ts";
import { configExists, getSecret, loadConfig, routeFor } from "./config.ts";
import {
  TERMINAL,
  chargeTokens,
  createTask,
  dayTokens,
  getEvents,
  getTask,
  latestTask,
  listLocks,
  listTasks,
  logEvent,
  reapStaleLocks,
  releaseLocks,
  resolveTask,
  setStatus,
  updateTask,
  type Task,
} from "./db.ts";
import {
  changedFiles,
  checkPrereqs,
  deleteBranch,
  diffFull,
  diffStat,
  ensureExcluded,
  mergeBranch,
  optionalTools,
  removeWorktree,
  repoRoot,
} from "./git.ts";
import {
  capturePane,
  executeTask,
  reapOrphans,
  sessionName,
  spawnDetached,
  tmuxExists,
  tmuxKill,
  tmuxList,
} from "./runner.ts";
import { probeProvider } from "./llm.ts";

// ------------------------------------------------------------------ arg parse

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  if (argv.length === 0) return { cmd: "chat", positional: [], flags: {} };
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k!] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) flags[k!] = argv[++i]!;
      else flags[k!] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { cmd: positional.shift() ?? "help", positional, flags };
}

let JSON_MODE = false;

function out(human: string, data?: unknown): void {
  if (JSON_MODE) console.log(JSON.stringify(data ?? { message: human }, null, 2));
  else console.log(human);
}

// ------------------------------------------------------------------ helpers

function mustTask(idOrPrefix: string | undefined): Task {
  const t = idOrPrefix ? resolveTask(idOrPrefix) : latestTask();
  if (!t) {
    throw notFound(
      idOrPrefix ? `no task matching "${idOrPrefix}"` : "no tasks yet",
      "list tasks with: mengcli status",
    );
  }
  return t;
}

const shortId = (id: string) => id.slice(-8);

function statusColor(s: string): string {
  if (s === "DELIVERED" || s === "MERGED") return c.green(s);
  if (s === "FAILED" || s === "CANCELLED") return c.red(s);
  if (s === "PAUSED") return c.yellow(s);
  return c.cyan(s);
}

/**
 * One line from the terminal. Opened once and reused: reading the stream per
 * question waits for EOF, which on a tty never comes, so the second prompt
 * would hang forever.
 */
let _rl: import("readline/promises").Interface | null = null;

async function ask(question: string, fallback = ""): Promise<string> {
  if (!_rl) {
    const readline = await import("readline/promises");
    _rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  }
  const line = await _rl.question(question + (fallback ? ` [${fallback}]` : "") + " ");
  return line.trim() || fallback;
}

function closeAsk(): void {
  _rl?.close();
  _rl = null;
}

// ------------------------------------------------------------------ commands

async function cmdInit(): Promise<number> {
  await checkPrereqs();
  const repo = await repoRoot();
  ensureDirs();
  await ensureExcluded(repo);
  const opt = optionalTools();
  const missing = Object.entries(opt)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  out(
    `initialised ${repo}\n` +
      `  config  ${CONFIG_FILE}${configExists() ? "" : c.yellow("  (missing — run: mengcli config)")}\n` +
      `  state   ${DB_FILE}\n` +
      (missing.length ? `  ${c.yellow("optional tools missing:")} ${missing.join(", ")}\n` : ""),
    { repo, config: CONFIG_FILE, db: DB_FILE, optional: opt },
  );
  return EXIT.OK;
}

async function cmdConfig(args: Args): Promise<number> {
  ensureDirs();
  if (args.positional[0] === "show") {
    if (!configExists()) throw new MengError(`no config at ${CONFIG_FILE}`, EXIT.BAD_CONFIG);
    const cfg = await loadConfig();
    out(await Bun.file(CONFIG_FILE).text(), cfg);
    return EXIT.OK;
  }

  const { runWizard } = await import("./wizard.ts");
  return runWizard();
}

async function cmdRun(args: Args): Promise<number> {
  await checkPrereqs();
  const cfg = await loadConfig();
  const prompt = args.positional.join(" ").trim();
  if (!prompt) throw new MengError('usage: mengcli run "<prompt>"');

  const repo = await repoRoot();
  await ensureExcluded(repo);

  const active = listTasks({ active: true });
  await reapOrphans(active);
  const running = listTasks({ active: true }).length;
  if (running >= cfg.budget.max_concurrent_agents) {
    throw new MengError(
      `${running} task(s) already active (limit ${cfg.budget.max_concurrent_agents})`,
      EXIT.GENERAL,
      "stop one with: mengcli stop <id>",
    );
  }
  if (dayTokens() >= cfg.budget.max_tokens_per_day) {
    throw new MengError("daily token budget exhausted", EXIT.BUDGET);
  }

  const task = createTask(prompt, repo);

  if (args.flags.fg) {
    setStatus(task.id, "PENDING" as never); // no-op; keeps status readable
    const status = await executeTask(task.id, (l) => info(l));
    return status === "DELIVERED" ? EXIT.OK : EXIT.CIRCUIT_BREAKER;
  }

  const session = await spawnDetached(task);
  out(
    `${c.green("started")} ${shortId(task.id)}  ${c.dim(session)}\n` +
      `  follow:  mengcli logs ${shortId(task.id)}\n` +
      `  status:  mengcli status`,
    { id: task.id, session, status: "PENDING" },
  );
  return EXIT.OK;
}

async function cmdWorker(args: Args): Promise<number> {
  const id = args.positional[0];
  if (!id) throw new MengError("_worker requires a task id");
  try {
    const status = await executeTask(id, (l) => console.log(l));
    console.log(`\n[mengcli] ${status}`);
    return status === "DELIVERED" ? EXIT.OK : EXIT.CIRCUIT_BREAKER;
  } catch (e) {
    releaseLocks(id);
    const t = getTask(id);
    if (t && !TERMINAL.includes(t.status)) {
      setStatus(id, "FAILED", (e as Error).message.slice(0, 300));
    }
    logEvent(id, { kind: "circuit_breaker.tripped", summary: (e as Error).message });
    console.error(`\n[mengcli] FAILED: ${(e as Error).message}`);
    return e instanceof MengError ? e.code : EXIT.GENERAL;
  }
}

async function cmdStatus(args: Args): Promise<number> {
  const all = listTasks({ limit: Number(args.flags.limit ?? 20) });
  await reapOrphans(all);
  reapStaleLocks();
  const tasks = listTasks({ limit: Number(args.flags.limit ?? 20) }).filter((t) =>
    args.flags.all ? true : !TERMINAL.includes(t.status) || Date.now() - t.updated_at < 864e5,
  );

  if (JSON_MODE) return out("", { tasks, locks: listLocks(), dayTokens: dayTokens() }), EXIT.OK;
  if (tasks.length === 0) {
    info("no tasks. start one with: mengcli run \"...\"");
    return EXIT.OK;
  }

  const rows = [["ID", "STATUS", "TOKENS", "ITER", "AGE", "PROMPT"]];
  for (const t of tasks) {
    rows.push([
      shortId(t.id),
      statusColor(t.status),
      String(t.tokens_used),
      String(t.iterations),
      ago(t.updated_at),
      t.prompt.slice(0, 46),
    ]);
  }
  console.log(table(rows));
  const locks = listLocks();
  if (locks.length) info(c.dim(`\n${locks.length} file lock(s) held`));
  info(c.dim(`today: ${dayTokens()} tokens`));
  return EXIT.OK;
}

async function cmdLogs(args: Args): Promise<number> {
  const task = mustTask(args.positional[0]);
  const session = task.tmux_session ?? sessionName(task.id);
  if (!(await tmuxExists(session))) {
    warn(`session ${session} is gone; showing the recorded trace instead`);
    return cmdTrace(args);
  }
  if (args.flags.follow || args.flags.f) {
    info(c.dim(`attaching to ${session} — detach with Ctrl-b d`));
    Bun.spawnSync(["tmux", "attach-session", "-t", session], { stdio: ["inherit", "inherit", "inherit"] });
    return EXIT.OK;
  }
  out(await capturePane(session, Number(args.flags.lines ?? 200)), { session });
  return EXIT.OK;
}

async function cmdTrace(args: Args): Promise<number> {
  const task = mustTask(args.positional[0]);
  const events = getEvents(task.id, Number(args.flags.limit ?? 500));
  if (JSON_MODE) return out("", { task, events }), EXIT.OK;

  info(
    `${c.bold(shortId(task.id))}  ${statusColor(task.status)}  ${c.dim(ago(task.created_at))}\n` +
      `${c.dim(task.prompt)}\n` +
      (task.branch ? `${c.dim("branch " + task.branch)}\n` : "") +
      (task.reason ? `${c.yellow("reason: " + task.reason)}\n` : ""),
  );

  const t0 = events[0]?.ts ?? task.created_at;
  for (const e of events) {
    const dt = ((e.ts - t0) / 1000).toFixed(1).padStart(6);
    const team = (e.team ?? "").padEnd(8);
    const tok = e.tokens_in + e.tokens_out;
    const cost = tok ? c.dim(` ${tok}tk`) : "";
    const dur = e.duration_ms ? c.dim(` ${e.duration_ms}ms`) : "";
    const kind = kindColor(e.kind);
    console.log(`${c.dim(dt + "s")} ${c.magenta(team)} ${kind} ${e.summary}${cost}${dur}`);
  }
  info(c.dim(`\n${events.length} events · ${task.tokens_used} tokens · ${task.iterations} iterations`));
  return EXIT.OK;
}

function kindColor(kind: string): string {
  if (kind.endsWith(".error") || kind.includes("denied") || kind.includes("exceeded"))
    return c.red(kind.padEnd(22));
  if (kind.startsWith("tool.") || kind.startsWith("mcp.")) return c.blue(kind.padEnd(22));
  if (kind.startsWith("git.") || kind.includes("status_changed")) return c.green(kind.padEnd(22));
  if (kind.includes("budget") || kind.includes("pause")) return c.yellow(kind.padEnd(22));
  return c.dim(kind.padEnd(22));
}

async function cmdStop(args: Args): Promise<number> {
  const task = mustTask(args.positional[0]);
  if (TERMINAL.includes(task.status)) {
    out(`${shortId(task.id)} is already ${task.status}`, { id: task.id, status: task.status });
    return EXIT.OK;
  }
  const session = task.tmux_session ?? sessionName(task.id);
  if (await tmuxExists(session)) await tmuxKill(session);
  releaseLocks(task.id);
  logEvent(task.id, { kind: "circuit_breaker.tripped", summary: "stopped by user" });
  setStatus(task.id, "CANCELLED", "stopped by user");
  out(`${c.yellow("stopped")} ${shortId(task.id)}`, { id: task.id, status: "CANCELLED" });
  return EXIT.OK;
}

async function cmdDiff(args: Args): Promise<number> {
  const task = mustTask(args.positional[0]);
  if (!task.branch) throw notFound("this task has no branch yet");

  // Prefer the worktree, but fall back to the repo once it has been cleaned up
  // so a merged task can still be inspected.
  const wt = taskWorktree(task.repo_path, task.id);
  const cwd = existsSync(wt) ? wt : task.repo_path;
  const head = existsSync(wt) ? "HEAD" : task.branch;
  const base = task.base_sha ?? task.base_branch ?? "HEAD~1";

  const body = args.flags.stat
    ? await diffStat(cwd, base, head)
    : await diffFull(cwd, base, head);
  out(body || "(no changes)", { id: task.id, branch: task.branch, base, diff: body });
  return EXIT.OK;
}

async function cmdMerge(args: Args): Promise<number> {
  const task = mustTask(args.positional[0]);
  if (task.status !== "DELIVERED") {
    throw new MengError(
      `task ${shortId(task.id)} is ${task.status}; only DELIVERED tasks can be merged`,
      EXIT.GENERAL,
    );
  }
  if (!task.branch) throw notFound("this task has no branch");

  const wt = taskWorktree(task.repo_path, task.id);
  const files = existsSync(wt)
    ? await changedFiles(wt, task.base_sha ?? "HEAD~1")
    : [];

  if (!args.flags.yes && !args.flags.y && process.stdin.isTTY) {
    info(`about to merge ${c.bold(task.branch)} into the current branch of ${task.repo_path}`);
    info(files.length ? files.map((f) => "  " + f).join("\n") : "  (no files reported)");
    const answer = await ask("proceed? [y/N]", "N");
    closeAsk();
    if (!/^y(es)?$/i.test(answer)) {
      out("aborted", { merged: false });
      return EXIT.OK;
    }
  }

  // Merge back into the branch the task was cut from, not whatever is checked
  // out now, unless that branch is gone.
  const current = await (await import("./git.ts")).currentBranch(task.repo_path);
  const base = task.base_branch ?? current;
  const result = await mergeBranch(task.repo_path, task.branch, base);
  await removeWorktree(task.repo_path, task.id);
  setStatus(task.id, "MERGED", `merged into ${base}`);
  logEvent(task.id, { kind: "git.commit", summary: `merged ${task.branch} into ${base}` });
  out(`${c.green("merged")} ${task.branch} → ${base}\n${result}`, {
    id: task.id,
    branch: task.branch,
    base,
    merged: true,
  });
  return EXIT.OK;
}

async function cmdClean(args: Args): Promise<number> {
  const repo = await repoRoot();
  const tasks = listTasks({ limit: 500 }).filter(
    (t) => t.repo_path === repo && TERMINAL.includes(t.status),
  );
  let removed = 0;
  for (const t of tasks) {
    const wt = taskWorktree(repo, t.id);
    if (!existsSync(wt)) continue;
    await removeWorktree(repo, t.id);
    if (args.flags.branches && t.branch && t.status !== "MERGED") {
      await deleteBranch(repo, t.branch);
    }
    removed++;
  }
  const dir = workspaceDir(repo);
  if (removed && existsSync(dir)) {
    const rest = [...new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false })];
    if (rest.length === 0) await rm(dir, { recursive: true, force: true });
  }

  // Sessions are kept alive after exit so logs stay readable; reap them once
  // the task itself is finished.
  const live = new Set(await tmuxList());
  let sessions = 0;
  for (const t of tasks) {
    const s = t.tmux_session ?? sessionName(t.id);
    if (live.has(s)) {
      await tmuxKill(s);
      sessions++;
    }
  }

  out(`removed ${removed} worktree(s), ${sessions} session(s)`, { removed, sessions });
  return EXIT.OK;
}

async function cmdReply(args: Args): Promise<number> {
  // `reply <id> "<answer>"` and `reply "<answer>"` are both accepted, so the
  // first word is only treated as an ID when it actually resolves to one.
  const first = args.positional[0];
  const looksLikeId = first !== undefined && resolveTask(first) !== null;
  const task = looksLikeId ? resolveTask(first!)! : mustTask(undefined);
  const answer = args.positional.slice(looksLikeId ? 1 : 0).join(" ").trim();

  if (task.status !== "PAUSED") {
    throw new MengError(`task ${shortId(task.id)} is ${task.status}, not PAUSED`, EXIT.GENERAL);
  }
  if (!answer) throw new MengError('usage: mengcli reply <id> "<answer>"');

  // The answer is stored separately; the worker folds it into the brief and
  // performs the PAUSED -> RUNNING transition itself.
  logEvent(task.id, { kind: "pause.resolved", summary: answer.slice(0, 300) });
  updateTask(task.id, { answer });

  const session = await spawnDetached(getTask(task.id)!);
  out(`${c.green("resumed")} ${shortId(task.id)} ${c.dim(session)}`, { id: task.id, session });
  return EXIT.OK;
}

async function cmdDoctor(): Promise<number> {
  const rows: string[][] = [["CHECK", "RESULT"]];
  const push = (k: string, ok: boolean, detail = "") =>
    rows.push([k, (ok ? c.green("ok") : c.red("missing")) + (detail ? " " + c.dim(detail) : "")]);

  push("git", !!Bun.which("git"));
  push("tmux", !!Bun.which("tmux"));
  for (const [k, v] of Object.entries(optionalTools())) push(`${k} (optional)`, v);
  push("config", configExists(), CONFIG_FILE);

  let providerOk = false;
  let detail = "";
  if (configExists()) {
    try {
      const cfg = await loadConfig();
      const { provider, model } = routeFor(cfg, "_default");
      const key = await getSecret(provider.secret_ref);
      push("api key", !!key, provider.secret_ref);
      const err = await probeProvider(provider, model);
      providerOk = !err;
      detail = err ?? model;
    } catch (e) {
      detail = (e as Error).message;
    }
  }
  push("provider", providerOk, detail);
  push("sessions", true, `${(await tmuxList()).length} running`);

  if (JSON_MODE) return out("", { rows }), EXIT.OK;
  console.log(table(rows));
  return EXIT.OK;
}

function cmdHelp(): number {
  console.log(
    c.cyan(BANNER) +
      `
${c.bold("usage")}  mengcli <command> [options]

${c.bold("commands")}
  ${c.dim("(no command)")}        open the interactive shell
  chat                open the interactive shell
  run "<prompt>"      start a task in a detached tmux session
  status              list tasks, locks and today's token spend
  logs <id>           show the live pane (--follow to attach)
  trace <id>          replay the agent's decisions from the event log
  diff <id>           show the task's diff (--stat for a summary)
  merge <id>          merge the task branch (asks first; -y to skip)
  stop <id>           kill the session, release locks, cancel the task
  reply <id> "<txt>"  answer a PAUSED task and resume it
  clean               remove worktrees for finished tasks
  config              set up the provider, model and API key
  config show         print the current configuration
  init                prepare the current repository
  doctor              check prerequisites and credentials

${c.bold("options")}
  --json              machine-readable output
  --fg                run in the foreground instead of tmux (run)
  --all               include finished tasks (status)
  -y                  skip the confirmation prompt (merge)

${c.dim("ids may be abbreviated; omit the id to use the most recent task")}
`,
  );
  return EXIT.OK;
}

// ------------------------------------------------------------------ main

const HANDLERS: Record<string, (a: Args) => Promise<number> | number> = {
  init: cmdInit,
  config: cmdConfig,
  run: cmdRun,
  status: cmdStatus,
  ls: cmdStatus,
  logs: cmdLogs,
  trace: cmdTrace,
  diff: cmdDiff,
  merge: cmdMerge,
  stop: cmdStop,
  cancel: cmdStop,
  clean: cmdClean,
  reply: cmdReply,
  doctor: cmdDoctor,
  help: cmdHelp,
  chat: cmdChat,
  _worker: cmdWorker,
};

async function cmdChat(): Promise<number> {
  await checkPrereqs();
  const { runTui } = await import("./tui.ts");
  return runTui();
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  JSON_MODE = args.flags.json === true || args.flags.json === "true";

  if (args.flags.version || args.flags.v || args.cmd === "version") {
    const pkg = await import("../package.json");
    out(pkg.default.version, { version: pkg.default.version });
    return EXIT.OK;
  }

  const handler = HANDLERS[args.cmd];
  if (!handler) {
    fail(`unknown command "${args.cmd}"`);
    cmdHelp();
    return EXIT.GENERAL;
  }
  return await handler(args);
}

try {
  process.exit(await main());
} catch (e) {
  if (e instanceof MengError) {
    fail(e.message);
    if (e.hint) info(c.dim(e.hint));
    process.exit(e.code);
  }
  fail((e as Error).message);
  if (process.env.MENGCLI_DEBUG) console.error(e);
  process.exit(EXIT.GENERAL);
}
