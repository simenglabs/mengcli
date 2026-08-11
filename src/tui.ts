import * as readline from "readline/promises";
import { existsSync } from "fs";
import { basename } from "path";
import { EXIT, MengError } from "./errors.ts";
import { loadConfig, configExists, routeFor } from "./config.ts";
import { Spinner, ago, box, c, fmtElapsed, fmtTokens, table } from "./ui.ts";
import { taskWorktree } from "./paths.ts";
import {
  TERMINAL,
  dayTokens,
  getEvents,
  getTask,
  latestTask,
  listTasks,
  logEvent,
  releaseLocks,
  resolveTask,
  setStatus,
  updateTask,
  type Task,
} from "./db.ts";
import { changedFiles, currentBranch, diffStat, mergeBranch, removeWorktree, repoRoot } from "./git.ts";
import { executeTask, sessionName, tmuxExists, tmuxKill } from "./runner.ts";

/**
 * The interactive shell. A prompt is a task: type it and watch the agents work,
 * with slash commands for everything that is not itself a task.
 *
 * ponytail: single pane, no mouse, no scrollback of its own — the terminal's own
 * scrollback is the transcript. A full-screen alternate-buffer layout would need
 * its own scroll region and resize handling; add that when a second pane exists
 * to justify it.
 */

const SLASH = [
  "/status",
  "/diff",
  "/merge",
  "/trace",
  "/stop",
  "/tasks",
  "/attach",
  "/clear",
  "/help",
  "/exit",
] as const;

function header(repo: string, branch: string, model: string): string {
  return box([
    `${c.bold("mengCLI")}  ${c.dim("AI agent by Menglabs")}`,
    "",
    `${c.dim("repo")}   ${basename(repo)} ${c.dim("on")} ${branch}`,
    `${c.dim("model")}  ${model}`,
    `${c.dim("help")}   /help ${c.dim("· submit an empty line to exit")}`,
  ]);
}

/** Slash commands and prior prompts, newest first. */
function completer(line: string, history: string[]): [string[], string] {
  if (line.startsWith("/")) {
    const hits = SLASH.filter((s) => s.startsWith(line));
    return [hits.length ? [...hits] : [...SLASH], line];
  }
  const hits = history.filter((h) => h.startsWith(line) && h !== line);
  return [hits, line];
}

export async function runTui(): Promise<number> {
  if (!process.stdin.isTTY) {
    throw new MengError("the interactive shell needs a terminal", EXIT.GENERAL, 'pipe a prompt to: mengcli run "..."');
  }
  if (!configExists()) {
    throw new MengError("no configuration yet", EXIT.BAD_CONFIG, "run: mengcli config");
  }

  const cfg = await loadConfig();
  const repo = await repoRoot();
  const branch = await currentBranch(repo);
  const { model } = routeFor(cfg, "_default");

  console.log(header(repo, branch, model));
  console.log();

  const history: string[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => completer(line, history),
    historySize: 200,
    prompt: c.cyan("› "),
  });

  // Ctrl-C cancels the line rather than the process; the running task, if any,
  // installs its own handler while it is in the foreground.
  rl.on("SIGINT", () => {
    rl.write(null, { ctrl: true, name: "u" });
    process.stdout.write("\n" + c.cyan("› "));
  });

  // Lines are queued from a permanent listener rather than a per-iteration
  // question(): a task takes seconds to run, and anything typed or pasted in
  // the meantime must survive rather than fall on the floor. `null` means EOF,
  // which also unblocks a pending read instead of hanging.
  const queue: string[] = [];
  let waiting: ((v: string | null) => void) | null = null;
  let closed = false;

  rl.on("line", (l) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(l);
    } else queue.push(l);
  });
  rl.on("close", () => {
    closed = true;
    waiting?.(null);
    waiting = null;
  });

  const prompt = async (q: string): Promise<string | null> => {
    if (queue.length) return queue.shift()!;
    if (closed) return null;
    process.stdout.write(q);
    return new Promise<string | null>((res) => (waiting = res));
  };

  let last: Task | null = latestTask();

  for (;;) {
    const answer = await prompt(c.cyan("› "));
    if (answer === null) break;
    const line = answer.trim();
    if (!line) break;
    history.unshift(line);

    try {
      if (line.startsWith("/")) {
        const [cmd = "", ...rest] = line.split(/\s+/);
        const arg = rest.join(" ");
        if (cmd === "/exit" || cmd === "/quit") break;
        last = (await slash(cmd, arg, last, prompt)) ?? last;
        continue;
      }
      // A paused task owns the next prompt: it is an answer, not a new task.
      last =
        last?.status === "PAUSED"
          ? await resumeInline(last, line, cfg.budget.max_tokens_per_task)
          : await runInline(line, repo, cfg.budget.max_tokens_per_task);
    } catch (e) {
      if (e instanceof MengError) {
        console.log(c.red("error: ") + e.message + (e.hint ? "\n" + c.dim(e.hint) : ""));
      } else {
        console.log(c.red("error: ") + (e as Error).message);
      }
    }
    console.log();
  }

  rl.close();
  console.log(c.dim("bye"));
  return EXIT.OK;
}

/** Run a task in the foreground, streaming agent activity into the scrollback. */
async function runInline(prompt: string, repo: string, taskBudget: number): Promise<Task> {
  const { createTask } = await import("./db.ts");
  const { ensureExcluded } = await import("./git.ts");
  await ensureExcluded(repo);
  return drive(createTask(prompt, repo), taskBudget);
}

/** Feed the answer to a PAUSED task and keep watching it in the foreground. */
async function resumeInline(task: Task, answer: string, taskBudget: number): Promise<Task> {
  logEvent(task.id, { kind: "pause.resolved", summary: answer.slice(0, 300) });
  updateTask(task.id, { answer });
  console.log(c.dim("resuming..."));
  return drive(getTask(task.id)!, taskBudget);
}

async function drive(task: Task, taskBudget: number): Promise<Task> {
  const started = Date.now();
  const spin = new Spinner();
  let team = "starting";

  const relabel = () => {
    const t = getTask(task.id);
    const tok = t ? fmtTokens(t.tokens_used) : "0";
    const pct = t ? Math.round((t.tokens_used / taskBudget) * 100) : 0;
    const budget = pct >= 80 ? c.yellow(` ${pct}%`) : "";
    spin.setLabel(`${team} ${c.dim(fmtElapsed(Date.now() - started))} ${c.dim(tok + "tk")}${budget}`);
  };

  console.log(`${c.dim("task")} ${task.id.slice(-8)}`);
  spin.start(`${team} ${c.dim("0s")}`);

  const tick = setInterval(relabel, 250);
  tick.unref?.();

  // Ctrl-C stops the task instead of killing the shell.
  let cancelled = false;
  const onSigint = () => {
    cancelled = true;
    spin.print(c.yellow("  stopping..."));
  };
  process.on("SIGINT", onSigint);

  let status: string;
  try {
    status = await executeTask(task.id, (l) => {
      if (cancelled) throw new MengError("cancelled by user", EXIT.GENERAL);
      // Relabel immediately: a fast task can finish between two ticks.
      const m = /^▶ (\w+) started/.exec(l);
      if (m) {
        team = m[1]!;
        relabel();
      }
      spin.print(decorate(l));
    });
  } catch (e) {
    releaseLocks(task.id);
    const t = getTask(task.id);
    if (t && !TERMINAL.includes(t.status)) {
      setStatus(task.id, cancelled ? "CANCELLED" : "FAILED", (e as Error).message.slice(0, 300));
    }
    status = cancelled ? "CANCELLED" : "FAILED";
    if (!cancelled) logEvent(task.id, { kind: "circuit_breaker.tripped", summary: (e as Error).message });
  } finally {
    clearInterval(tick);
    spin.stop();
    process.off("SIGINT", onSigint);
  }

  const done = getTask(task.id)!;
  const elapsed = fmtElapsed(Date.now() - started);
  const cost = `${c.dim(`${done.tokens_used} tokens · ${done.iterations} iterations · ${elapsed}`)}`;

  if (status === "DELIVERED") {
    console.log(`${c.green("✔ delivered")}  ${c.bold(done.branch ?? "")}  ${cost}`);
    console.log(c.dim("  /diff to review · /merge to accept"));
  } else if (status === "PAUSED") {
    console.log(`${c.yellow("⏸ paused")}  ${done.reason ?? ""}`);
    console.log(c.dim("  type your answer to continue"));
  } else {
    console.log(`${c.red("✘ " + status.toLowerCase())}  ${done.reason ?? ""}  ${cost}`);
  }
  return done;
}

/** Give the worker's plain lines the same shape as the rest of the shell. */
function decorate(line: string): string {
  if (line.startsWith("▶")) return c.magenta(line);
  if (line.startsWith("✔")) return c.green(line);
  if (line.startsWith("  ⚙")) return c.dim(line);
  if (line.startsWith("  ⟳")) return c.yellow(line);
  if (line.startsWith("  ⚠")) return c.yellow(line);
  return c.dim("  " + line);
}

type Prompt = (q: string) => Promise<string | null>;

async function slash(
  cmd: string,
  arg: string,
  last: Task | null,
  prompt: Prompt,
): Promise<Task | null> {
  const pick = (): Task => {
    const t = arg ? resolveTask(arg) : (last ?? latestTask());
    if (!t) throw new MengError(arg ? `no task matching "${arg}"` : "no tasks yet");
    return t;
  };

  switch (cmd) {
    case "/help":
      console.log(
        `${c.bold("type a prompt")} to start a task, or use:\n\n` +
          `  ${c.cyan("/status")}        tasks, locks and today's spend\n` +
          `  ${c.cyan("/tasks")}         recent tasks including finished ones\n` +
          `  ${c.cyan("/diff")} [id]     review the changes\n` +
          `  ${c.cyan("/merge")} [id]    merge the task branch\n` +
          `  ${c.cyan("/trace")} [id]    replay the agents' decisions\n` +
          `  ${c.cyan("/stop")} [id]     cancel a running task\n` +
          `  ${c.cyan("/attach")} [id]   attach to a background tmux session\n` +
          `  ${c.cyan("/clear")}         clear the screen\n` +
          `  ${c.cyan("/exit")}          leave (or submit an empty line)\n\n` +
          `${c.dim("tab completes · ↑ recalls · Ctrl-C stops the running task")}`,
      );
      return last;

    case "/clear":
      console.clear();
      return last;

    case "/status":
    case "/tasks": {
      const tasks = listTasks({ limit: 15 }).filter((t) =>
        cmd === "/tasks" ? true : !TERMINAL.includes(t.status) || Date.now() - t.updated_at < 864e5,
      );
      if (!tasks.length) {
        console.log(c.dim("no tasks yet"));
        return last;
      }
      const rows = [["ID", "STATUS", "TOKENS", "AGE", "PROMPT"]];
      for (const t of tasks) {
        rows.push([
          t.id.slice(-8),
          colorStatus(t.status),
          fmtTokens(t.tokens_used),
          ago(t.updated_at),
          t.prompt.slice(0, 44),
        ]);
      }
      console.log(table(rows));
      console.log(c.dim(`today: ${dayTokens()} tokens`));
      return last;
    }

    case "/diff": {
      const t = pick();
      if (!t.branch) throw new MengError("this task has no branch yet");
      const wt = taskWorktree(t.repo_path, t.id);
      const cwd = existsSync(wt) ? wt : t.repo_path;
      const head = existsSync(wt) ? "HEAD" : t.branch;
      console.log(await diffStat(cwd, t.base_sha ?? t.base_branch ?? "HEAD~1", head));
      return t;
    }

    case "/merge": {
      const t = pick();
      if (t.status !== "DELIVERED") {
        throw new MengError(`task ${t.id.slice(-8)} is ${t.status}; only DELIVERED tasks merge`);
      }
      if (!t.branch) throw new MengError("this task has no branch");
      const wt = taskWorktree(t.repo_path, t.id);
      const files = existsSync(wt) ? await changedFiles(wt, t.base_sha ?? "HEAD~1") : [];
      console.log(`merging ${c.bold(t.branch)} into ${t.base_branch ?? "the current branch"}`);
      if (files.length) console.log(files.map((f) => c.dim("  " + f)).join("\n"));
      const answer = (await prompt(c.yellow("proceed? [y/N] ")))?.trim() ?? "";
      if (!/^y(es)?$/i.test(answer)) {
        console.log(c.dim("aborted"));
        return t;
      }
      const base = t.base_branch ?? (await currentBranch(t.repo_path));
      await mergeBranch(t.repo_path, t.branch, base);
      await removeWorktree(t.repo_path, t.id);
      setStatus(t.id, "MERGED", `merged into ${base}`);
      logEvent(t.id, { kind: "git.commit", summary: `merged ${t.branch} into ${base}` });
      console.log(`${c.green("merged")} ${t.branch} → ${base}`);
      return getTask(t.id)!;
    }

    case "/trace": {
      const t = pick();
      const events = getEvents(t.id, 200);
      const t0 = events[0]?.ts ?? t.created_at;
      for (const e of events) {
        const dt = ((e.ts - t0) / 1000).toFixed(1).padStart(6);
        console.log(
          `${c.dim(dt + "s")} ${c.magenta((e.team ?? "").padEnd(8))} ${c.dim(e.kind.padEnd(20))} ${e.summary}`,
        );
      }
      console.log(c.dim(`${events.length} events · ${t.tokens_used} tokens`));
      return t;
    }

    case "/stop": {
      const t = pick();
      if (TERMINAL.includes(t.status)) {
        console.log(c.dim(`${t.id.slice(-8)} is already ${t.status}`));
        return t;
      }
      const s = t.tmux_session ?? sessionName(t.id);
      if (await tmuxExists(s)) await tmuxKill(s);
      releaseLocks(t.id);
      setStatus(t.id, "CANCELLED", "stopped by user");
      console.log(`${c.yellow("stopped")} ${t.id.slice(-8)}`);
      return getTask(t.id)!;
    }

    case "/attach": {
      const t = pick();
      const s = t.tmux_session ?? sessionName(t.id);
      if (!(await tmuxExists(s))) throw new MengError(`no live session for ${t.id.slice(-8)}`);
      console.log(c.dim(`attaching to ${s} — detach with Ctrl-b d`));
      Bun.spawnSync(["tmux", "attach-session", "-t", s], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      return t;
    }

    default:
      throw new MengError(`unknown command ${cmd}`, EXIT.GENERAL, "try /help");
  }
}

function colorStatus(s: string): string {
  if (s === "DELIVERED" || s === "MERGED") return c.green(s);
  if (s === "FAILED" || s === "CANCELLED") return c.red(s);
  if (s === "PAUSED") return c.yellow(s);
  return c.cyan(s);
}

