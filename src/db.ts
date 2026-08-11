import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { DB_FILE, ensureDirs } from "./paths.ts";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  prompt        TEXT NOT NULL,
  repo_path     TEXT NOT NULL,
  branch        TEXT,
  base_branch   TEXT,
  base_sha      TEXT,
  status        TEXT NOT NULL,
  tmux_session  TEXT,
  tokens_used   INTEGER NOT NULL DEFAULT 0,
  iterations    INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,
  answer        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  ts          INTEGER NOT NULL,
  team        TEXT,
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  payload     TEXT,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, ts);

CREATE TABLE IF NOT EXISTS locks (
  file_path   TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  team        TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  day         TEXT PRIMARY KEY,
  tokens_used INTEGER NOT NULL DEFAULT 0
);
`;

export type TaskStatus =
  | "PENDING"
  | "PLANNING"
  | "RUNNING"
  | "PAUSED"
  | "DELIVERED"
  | "MERGED"
  | "FAILED"
  | "CANCELLED";

export const TERMINAL: TaskStatus[] = ["MERGED", "FAILED", "CANCELLED"];

/** Allowed transitions, PRD Sec 8. */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ["PLANNING", "CANCELLED", "FAILED"],
  PLANNING: ["RUNNING", "PAUSED", "FAILED", "CANCELLED"],
  RUNNING: ["DELIVERED", "PAUSED", "FAILED", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED", "FAILED"],
  DELIVERED: ["MERGED", "CANCELLED"],
  MERGED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface Task {
  id: string;
  prompt: string;
  repo_path: string;
  branch: string | null;
  /** Branch the worktree was cut from; diffs and merges resolve against it. */
  base_branch: string | null;
  /** Commit the worktree was cut from, so diffs survive later base movement. */
  base_sha: string | null;
  status: TaskStatus;
  tmux_session: string | null;
  tokens_used: number;
  iterations: number;
  reason: string | null;
  /** Latest user reply to a stateful pause, consumed on resume. */
  answer: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface EventRow {
  id: number;
  task_id: string;
  ts: number;
  team: string | null;
  kind: string;
  summary: string;
  payload: string | null;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number | null;
}

export const EVENT_KINDS = [
  "task.created",
  "task.status_changed",
  "team.handoff",
  "llm.request",
  "llm.response",
  "llm.error",
  "tool.call",
  "tool.result",
  "tool.denied",
  "mcp.call",
  "mcp.result",
  "lock.acquired",
  "lock.released",
  "lock.denied",
  "budget.warning",
  "budget.exceeded",
  "pause.requested",
  "pause.resolved",
  "telegram.inbound",
  "telegram.outbound",
  "git.branch",
  "git.commit",
  "circuit_breaker.tripped",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

let _db: Database | null = null;
let _dbPath: string | null = null;

export function db(): Database {
  const path = process.env.MENGCLI_DB || DB_FILE;
  if (_db && _dbPath === path) return _db;
  _db?.close();
  ensureDirs();
  // MENGCLI_DB may point outside STATE_DIR, so ensureDirs() is not enough.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const d = new Database(path, { create: true });
  // WAL is mandatory: several tmux sessions write concurrently.
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA busy_timeout = 5000");
  d.exec("PRAGMA foreign_keys = ON");
  d.exec("PRAGMA synchronous = NORMAL");
  d.run(SCHEMA);
  migrate(d);
  _db = d;
  _dbPath = path;
  return d;
}

/**
 * Additive migrations for databases created by an earlier version. Columns are
 * added one at a time and failures are ignored, which keeps an upgrade from
 * bricking an existing install.
 */
function migrate(d: Database): void {
  const columns = (table: string) =>
    new Set(d.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((r) => r.name));

  const taskCols = columns("tasks");
  const additions: Array<[string, string]> = [
    ["base_branch", "TEXT"],
    ["base_sha", "TEXT"],
    ["reason", "TEXT"],
    ["answer", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (taskCols.has(name)) continue;
    try {
      d.run(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    } catch {
      /* another process won the race */
    }
  }
}

export function closeDb(): void {
  _db?.close();
  _db = null;
  _dbPath = null;
}

const now = () => Date.now();

// ---------------------------------------------------------------- tasks

export function createTask(prompt: string, repoPath: string): Task {
  const id = Bun.randomUUIDv7();
  const t = now();
  db()
    .query(
      `INSERT INTO tasks (id, prompt, repo_path, status, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?)`,
    )
    .run(id, prompt, repoPath, t, t);
  logEvent(id, { kind: "task.created", summary: prompt.slice(0, 200) });
  return getTask(id)!;
}

export function getTask(id: string): Task | null {
  return db().query<Task, [string]>("SELECT * FROM tasks WHERE id = ?").get(id) ?? null;
}

/** Accepts a unique ID prefix so users need not paste the full ULID. */
export function resolveTask(idOrPrefix: string): Task | null {
  const exact = getTask(idOrPrefix);
  if (exact) return exact;
  const rows = db()
    .query<Task, [string]>("SELECT * FROM tasks WHERE id LIKE ? ORDER BY created_at DESC")
    .all(idOrPrefix + "%");
  return rows.length === 1 ? rows[0]! : null;
}

export function latestTask(): Task | null {
  return db().query<Task, []>("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 1").get() ?? null;
}

export function listTasks(opts: { active?: boolean; limit?: number } = {}): Task[] {
  const limit = opts.limit ?? 50;
  if (opts.active) {
    return db()
      .query<Task, [number]>(
        `SELECT * FROM tasks WHERE status NOT IN ('MERGED','FAILED','CANCELLED')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit);
  }
  return db()
    .query<Task, [number]>("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

export function setStatus(id: string, status: TaskStatus, reason?: string): void {
  const task = getTask(id);
  if (!task) throw new Error(`task ${id} not found`);
  if (task.status === status) return;
  if (!canTransition(task.status, status)) {
    throw new Error(`illegal transition ${task.status} -> ${status} for task ${id}`);
  }
  const finished = TERMINAL.includes(status) ? now() : null;
  db()
    .query(
      `UPDATE tasks SET status = ?, reason = COALESCE(?, reason),
       updated_at = ?, finished_at = ? WHERE id = ?`,
    )
    .run(status, reason ?? null, now(), finished, id);
  logEvent(id, {
    kind: "task.status_changed",
    summary: `${task.status} -> ${status}${reason ? ` (${reason})` : ""}`,
  });
}

export function updateTask(
  id: string,
  fields: Partial<Pick<Task, "branch" | "base_branch" | "base_sha" | "tmux_session" | "answer" | "prompt">>,
): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v as string | null);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  vals.push(now(), id);
  db()
    .query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
}

// ---------------------------------------------------------------- events

/** Whole match is the secret. */
const SECRET_TOKENS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Group 1 is the key name and separator; the value after it is the secret. */
const SECRET_ASSIGNMENTS: RegExp[] =
  [/("?(?:api[_-]?key|apikey|authorization|auth|token|password|passwd|secret)"?\s*[:=]\s*"?)([^"'\s,}]{8,})/gi];

/** Strip credential-looking substrings before anything is written to disk. */
export function redact(input: string): string {
  let out = input;
  for (const re of SECRET_TOKENS) out = out.replace(re, "[REDACTED]");
  for (const re of SECRET_ASSIGNMENTS) out = out.replace(re, (_m, prefix: string) => `${prefix}[REDACTED]`);
  return out;
}

export interface EventInput {
  kind: EventKind;
  summary: string;
  team?: string;
  payload?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
}

export function logEvent(taskId: string, e: EventInput): void {
  const payload =
    e.payload === undefined ? null : redact(JSON.stringify(e.payload).slice(0, 100_000));
  db()
    .query(
      `INSERT INTO events (task_id, ts, team, kind, summary, payload, tokens_in, tokens_out, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      taskId,
      now(),
      e.team ?? null,
      e.kind,
      redact(e.summary).slice(0, 2000),
      payload,
      e.tokensIn ?? 0,
      e.tokensOut ?? 0,
      e.durationMs ?? null,
    );
}

export function getEvents(taskId: string, limit = 1000): EventRow[] {
  return db()
    .query<EventRow, [string, number]>(
      "SELECT * FROM events WHERE task_id = ? ORDER BY ts, id LIMIT ?",
    )
    .all(taskId, limit);
}

// ---------------------------------------------------------------- budget

const today = () => new Date().toISOString().slice(0, 10);

export interface BudgetState {
  taskTokens: number;
  dayTokens: number;
  iterations: number;
}

/**
 * Record token usage against both the task and the global daily ledger.
 * Every attempt counts, including retries — otherwise retries leak cost.
 */
export function chargeTokens(taskId: string, tokens: number, iterations = 0): BudgetState {
  const d = db();
  const tx = d.transaction(() => {
    d.query("UPDATE tasks SET tokens_used = tokens_used + ?, iterations = iterations + ?, updated_at = ? WHERE id = ?")
      .run(tokens, iterations, now(), taskId);
    d.query(
      `INSERT INTO budget_ledger (day, tokens_used) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET tokens_used = tokens_used + excluded.tokens_used`,
    ).run(today(), tokens);
  });
  tx();
  const task = getTask(taskId)!;
  return {
    taskTokens: task.tokens_used,
    dayTokens: dayTokens(),
    iterations: task.iterations,
  };
}

export function dayTokens(): number {
  const row = db()
    .query<{ tokens_used: number }, [string]>("SELECT tokens_used FROM budget_ledger WHERE day = ?")
    .get(today());
  return row?.tokens_used ?? 0;
}

// ---------------------------------------------------------------- locks

export interface LockRow {
  file_path: string;
  task_id: string;
  team: string;
  pid: number;
  acquired_at: number;
  expires_at: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Drop locks whose TTL has passed or whose owning process is gone. */
export function reapStaleLocks(): number {
  const d = db();
  const rows = d.query<LockRow, []>("SELECT * FROM locks").all();
  const dead = rows.filter((r) => r.expires_at < now() || !pidAlive(r.pid));
  if (dead.length === 0) return 0;
  const del = d.query("DELETE FROM locks WHERE file_path = ?");
  const tx = d.transaction(() => dead.forEach((r) => del.run(r.file_path)));
  tx();
  return dead.length;
}

/**
 * All-or-nothing lock acquisition in lexicographic order.
 *
 * Deadlock is prevented structurally rather than detected: an agent declares
 * every file up front, locks them sorted, and releases everything on any
 * failure. With no hold-and-wait there is no cycle to detect.
 */
export function acquireLocks(
  taskId: string,
  team: string,
  files: string[],
  ttlSeconds: number,
): { ok: true } | { ok: false; blockedBy: string; heldBy: string } {
  reapStaleLocks();
  const sorted = [...new Set(files)].sort();
  const d = db();
  const t = now();
  const expires = t + ttlSeconds * 1000;

  let conflict: { blockedBy: string; heldBy: string } | null = null;

  const tx = d.transaction(() => {
    for (const f of sorted) {
      const held = d.query<LockRow, [string]>("SELECT * FROM locks WHERE file_path = ?").get(f);
      if (held) {
        if (held.task_id === taskId && held.team === team) continue; // re-entrant
        conflict = { blockedBy: f, heldBy: `${held.team}@${held.task_id.slice(0, 8)}` };
        throw new Error("lock conflict"); // rolls the whole transaction back
      }
      d.query(
        `INSERT INTO locks (file_path, task_id, team, pid, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(f, taskId, team, process.pid, t, expires);
    }
  });

  try {
    tx();
  } catch {
    const c = conflict as { blockedBy: string; heldBy: string } | null;
    if (c) {
      logEvent(taskId, {
        kind: "lock.denied",
        team,
        summary: `blocked on ${c.blockedBy} held by ${c.heldBy}`,
      });
      return { ok: false, ...c };
    }
    throw new Error("lock acquisition failed");
  }

  if (sorted.length > 0) {
    logEvent(taskId, {
      kind: "lock.acquired",
      team,
      summary: `${sorted.length} file(s)`,
      payload: sorted,
    });
  }
  return { ok: true };
}

export function releaseLocks(taskId: string, team?: string): number {
  const d = db();
  const res = team
    ? d.query("DELETE FROM locks WHERE task_id = ? AND team = ?").run(taskId, team)
    : d.query("DELETE FROM locks WHERE task_id = ?").run(taskId);
  const n = res.changes;
  if (n > 0) logEvent(taskId, { kind: "lock.released", team, summary: `${n} file(s)` });
  return n;
}

export function listLocks(): LockRow[] {
  return db().query<LockRow, []>("SELECT * FROM locks ORDER BY file_path").all();
}

/** Backoff with jitter, used after a failed all-or-nothing acquisition. */
export function lockBackoff(attempt: number): number {
  const base = Math.min(200 * 2 ** attempt, 5_000);
  return base + Math.random() * base * 0.5;
}
