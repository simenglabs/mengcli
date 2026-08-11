import { loadConfig } from "./config.ts";
import {
  getTask,
  logEvent,
  releaseLocks,
  setStatus,
  updateTask,
  type Task,
  type TaskStatus,
} from "./db.ts";
import { existsSync } from "fs";
import { commitAll, createWorktree, diffStat, run } from "./git.ts";
import { runAgent, type Team } from "./agent.ts";
import { taskWorktree } from "./paths.ts";
import { EXIT, MengError } from "./errors.ts";

export const SESSION_PREFIX = "mengcli-";

export function sessionName(taskId: string): string {
  return SESSION_PREFIX + taskId.slice(-12);
}

export async function tmuxExists(session: string): Promise<boolean> {
  const r = await run(["tmux", "has-session", "-t", session], process.cwd(), 5000);
  return r.ok;
}

export async function tmuxKill(session: string): Promise<void> {
  await run(["tmux", "kill-session", "-t", session], process.cwd(), 5000);
}

export async function tmuxList(): Promise<string[]> {
  const r = await run(["tmux", "list-sessions", "-F", "#{session_name}"], process.cwd(), 5000);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter((s) => s.startsWith(SESSION_PREFIX));
}

/**
 * Launch the task in a detached tmux session so it survives terminal exit and
 * screen lock. Re-invokes this same binary with the hidden `_worker` command.
 */
export async function spawnDetached(task: Task): Promise<string> {
  const session = sessionName(task.id);
  const entry = Bun.main; // absolute path to src/index.ts
  const bun = process.execPath; // the Bun binary, not `mengcli` (see PRD 11.3)

  // Sessions linger after exit so logs stay readable; clear the old one before
  // reusing the name on resume.
  if (await tmuxExists(session)) await tmuxKill(session);

  const r = await run(
    [
      "tmux",
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      task.repo_path,
      bun,
      entry,
      "_worker",
      task.id,
    ],
    task.repo_path,
    10_000,
  );
  if (!r.ok) throw new MengError(`failed to start tmux session: ${r.stderr}`, EXIT.PREREQ);

  // Keep the pane after exit so `mengcli logs` can still read the scrollback.
  await run(["tmux", "set-option", "-t", session, "remain-on-exit", "on"], task.repo_path, 5000);
  updateTask(task.id, { tmux_session: session });
  return session;
}

export async function capturePane(session: string, lines = 200): Promise<string> {
  const r = await run(
    ["tmux", "capture-pane", "-p", "-t", session, "-S", `-${lines}`],
    process.cwd(),
    5000,
  );
  return r.ok ? r.stdout : "";
}

/** Tasks marked RUNNING whose tmux session is gone are orphans (PRD Sec 8). */
export async function reapOrphans(tasks: Task[]): Promise<number> {
  const live = new Set(await tmuxList());
  let n = 0;
  for (const t of tasks) {
    if (t.status !== "RUNNING" && t.status !== "PLANNING") continue;
    const s = t.tmux_session ?? sessionName(t.id);
    if (live.has(s)) continue;
    releaseLocks(t.id);
    setStatus(t.id, "FAILED", "orphaned: tmux session disappeared");
    n++;
  }
  return n;
}

const TEAM_ORDER: Team[] = ["planner", "riset", "dev"];

/** The worker body. Runs inside tmux; never called directly by the user. */
export async function executeTask(taskId: string, onLine: (s: string) => void): Promise<TaskStatus> {
  const cfg = await loadConfig();
  const task = getTask(taskId);
  if (!task) throw new MengError(`task ${taskId} not found`, EXIT.NOT_FOUND);

  const resuming = task.status === "PAUSED";
  const answer = task.answer;

  // A resumed task re-enters PLANNING through RUNNING; a fresh one starts there.
  if (resuming) {
    setStatus(task.id, "RUNNING", "resumed by user");
    updateTask(task.id, { answer: null });
  } else {
    setStatus(task.id, "PLANNING");
  }

  // Reuse an existing worktree when resuming, otherwise create one.
  let worktree = taskWorktree(task.repo_path, task.id);
  let branch = task.branch;
  if (!branch || !existsSync(worktree)) {
    const wt = await createWorktree(task.repo_path, task.id, task.prompt);
    worktree = wt.path;
    branch = wt.branch;
    updateTask(task.id, { branch, base_branch: wt.baseBranch, base_sha: wt.baseSha });
    logEvent(task.id, { kind: "git.branch", summary: `created ${branch} from ${wt.baseBranch}` });
    onLine(`branch ${branch}`);
  }

  const transcript: string[] = [];
  if (resuming && answer) {
    transcript.push(`## user clarification\n${answer}`);
    onLine(`resuming with: ${answer.slice(0, 120)}`);
  }

  if (!resuming) setStatus(task.id, "RUNNING");

  for (const team of TEAM_ORDER) {
    const out = await runAgent({
      taskId: task.id,
      team,
      cfg,
      worktree,
      brief:
        transcript.length === 0
          ? `User request:\n${task.prompt}`
          : `User request:\n${task.prompt}\n\nPrior findings:\n${transcript.join("\n\n")}`,
      onEvent: onLine,
    });

    if (out.status === "paused") {
      logEvent(task.id, { kind: "pause.requested", team, summary: out.question ?? "" });
      setStatus(task.id, "PAUSED", out.question);
      onLine(`paused: ${out.question}`);
      return "PAUSED";
    }
    if (out.status === "budget") {
      logEvent(task.id, { kind: "circuit_breaker.tripped", team, summary: out.summary });
      await commitIfDirty(worktree, task.prompt, task.id, onLine);
      setStatus(task.id, "FAILED", out.summary);
      return "FAILED";
    }
    if (out.status === "stalled") {
      logEvent(task.id, { kind: "circuit_breaker.tripped", team, summary: out.summary });
      await commitIfDirty(worktree, task.prompt, task.id, onLine);
      setStatus(task.id, "FAILED", out.summary);
      return "FAILED";
    }

    transcript.push(`## ${team}\n${out.summary}`);
  }

  const sha = await commitIfDirty(worktree, task.prompt, task.id, onLine);
  if (!sha) {
    setStatus(task.id, "FAILED", "agents finished without changing any files");
    return "FAILED";
  }

  const base = getTask(task.id)!.base_sha ?? "HEAD~1";
  const stat = await diffStat(worktree, base);
  onLine(stat || "(no diff)");
  setStatus(task.id, "DELIVERED", transcript.at(-1)?.slice(0, 500));
  return "DELIVERED";
}

async function commitIfDirty(
  worktree: string,
  prompt: string,
  taskId: string,
  onLine: (s: string) => void,
): Promise<string | null> {
  const subject = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
  const sha = await commitAll(worktree, `feat: ${subject}\n\nGenerated by mengcli task ${taskId}`);
  if (sha) {
    logEvent(taskId, { kind: "git.commit", summary: sha });
    onLine(`commit ${sha}`);
  }
  return sha;
}
