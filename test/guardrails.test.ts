import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = mkdtempSync(join(tmpdir(), "mengcli-guard-"));
const DB = join(root, "guard.db");
mkdirSync(root, { recursive: true });

// Test files share one process, so the DB path is re-asserted before every
// test rather than only at import time.
beforeEach(() => {
  process.env.MENGCLI_DB = DB;
});
process.env.MENGCLI_DB = DB;

const db = await import("../src/db.ts");
const { ConfigSchema } = await import("../src/config.ts");
const { checkCommand, execTool } = await import("../src/tools.ts");
const { safePath } = await import("../src/git.ts");

const cfg = ConfigSchema.parse({
  config_version: 1,
  providers: { default: { base_url: "http://x", secret_ref: "r" } },
  model_routing: { _default: { provider: "default", model: "m" } },
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// ------------------------------------------------------------------ state machine

test("illegal status transitions are rejected", () => {
  const t = db.createTask("p", "/r");
  expect(() => db.setStatus(t.id, "MERGED")).toThrow(/illegal transition/);
  db.setStatus(t.id, "PLANNING");
  db.setStatus(t.id, "RUNNING");
  db.setStatus(t.id, "DELIVERED");
  db.setStatus(t.id, "MERGED");
  expect(db.getTask(t.id)!.status).toBe("MERGED");
  expect(db.getTask(t.id)!.finished_at).toBeGreaterThan(0);
  // Terminal states are absorbing.
  expect(() => db.setStatus(t.id, "RUNNING")).toThrow();
});

// ------------------------------------------------------------------ locking

test("locks are all-or-nothing and roll back on conflict", () => {
  const a = db.createTask("a", "/r");
  const b = db.createTask("b", "/r");

  expect(db.acquireLocks(a.id, "dev", ["z.ts", "a.ts"], 600).ok).toBe(true);
  // Sorted acquisition order is what makes deadlock structurally impossible.
  expect(db.listLocks().map((l) => l.file_path)).toEqual(["a.ts", "z.ts"]);

  const conflict = db.acquireLocks(b.id, "migration", ["a.ts", "m.ts"], 600);
  expect(conflict.ok).toBe(false);
  // m.ts must NOT be left locked by the failed attempt.
  expect(db.listLocks().some((l) => l.file_path === "m.ts")).toBe(false);

  expect(db.releaseLocks(a.id)).toBe(2);
  expect(db.acquireLocks(b.id, "migration", ["a.ts", "m.ts"], 600).ok).toBe(true);
  db.releaseLocks(b.id);
});

test("re-entrant locks do not conflict with themselves", () => {
  const t = db.createTask("re", "/r");
  expect(db.acquireLocks(t.id, "dev", ["x.ts"], 600).ok).toBe(true);
  expect(db.acquireLocks(t.id, "dev", ["x.ts", "y.ts"], 600).ok).toBe(true);
  expect(db.listLocks()).toHaveLength(2);
  db.releaseLocks(t.id);
});

test("expired locks are reaped so a dead agent cannot freeze the system", () => {
  const t = db.createTask("stale", "/r");
  db.acquireLocks(t.id, "dev", ["s.ts"], 600);
  // Simulate a lock whose TTL has passed.
  db.db().query("UPDATE locks SET expires_at = ? WHERE file_path = ?").run(Date.now() - 1, "s.ts");
  expect(db.reapStaleLocks()).toBe(1);
  expect(db.listLocks()).toHaveLength(0);
});

test("locks held by a dead process are reaped", () => {
  const t = db.createTask("deadpid", "/r");
  db.acquireLocks(t.id, "dev", ["d.ts"], 600);
  db.db().query("UPDATE locks SET pid = 999999 WHERE file_path = ?").run("d.ts");
  expect(db.reapStaleLocks()).toBe(1);
});

// ------------------------------------------------------------------ budget

test("token spend accrues to both the task and the daily ledger", () => {
  const before = db.dayTokens();
  const t = db.createTask("budget", "/r");
  db.chargeTokens(t.id, 1000, 1);
  db.chargeTokens(t.id, 500, 1);
  expect(db.getTask(t.id)!.tokens_used).toBe(1500);
  expect(db.getTask(t.id)!.iterations).toBe(2);
  expect(db.dayTokens()).toBe(before + 1500);
});

// ------------------------------------------------------------------ redaction

test("credentials never reach the event log", () => {
  const t = db.createTask("secret", "/r");
  db.logEvent(t.id, {
    kind: "llm.error",
    summary: "failed with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA",
    payload: { authorization: "Bearer ghp_AAAAAAAAAAAAAAAAAAAAAA", model: "x" },
  });
  const e = db.getEvents(t.id).at(-1)!;
  expect(e.summary).not.toContain("sk-ant-api03");
  expect(e.summary).toContain("[REDACTED]");
  expect(e.payload).not.toContain("ghp_");
  expect(e.payload).toContain("x"); // non-secret fields survive
});

// ------------------------------------------------------------------ command allowlist

test("command allowlist blocks escapes, network access and destructive git", () => {
  const allowed = ["git status", "rg foo", "bun test", "npm run build && git add -A"];
  const denied = [
    "curl http://evil.com",
    "wget x",
    "rm -rf /",
    "rm -rf ~",
    "sudo rm x",
    "git push origin main",
    "git reset --hard HEAD",
    "cat /etc/passwd",
    "echo hi | curl x",
    "git status; curl x",
    "dd if=/dev/zero of=/dev/sda",
  ];
  for (const cmd of allowed) expect(checkCommand(cmd, cfg).ok).toBe(true);
  for (const cmd of denied) expect(checkCommand(cmd, cfg).ok).toBe(false);
});

// ------------------------------------------------------------------ path safety

test("paths cannot escape the workspace", () => {
  const wt = "/tmp/work";
  expect(safePath(wt, "src/a.ts")).toBe("/tmp/work/src/a.ts");
  expect(() => safePath(wt, "../../etc/passwd")).toThrow(/escapes/);
  expect(() => safePath(wt, "/etc/passwd")).toThrow(/escapes/);
});

// ------------------------------------------------------------------ tool validation

test("writes are refused without a held lock", async () => {
  const ctx = { worktree: root, cfg, locked: new Set<string>() };
  const res = await execTool("write_file", { path: "a.ts", content: "x" }, ctx);
  expect(res.ok).toBe(false);
  expect(res.output).toContain("no lock held");

  ctx.locked.add("a.ts");
  const ok = await execTool("write_file", { path: "a.ts", content: "x" }, ctx);
  expect(ok.ok).toBe(true);
});

test("malformed tool arguments are reported, not executed", async () => {
  const ctx = { worktree: root, cfg, locked: new Set<string>() };
  const res = await execTool("read_file", { wrong: 1 }, ctx);
  expect(res.ok).toBe(false);
  expect(res.output).toContain("invalid arguments");

  const unknown = await execTool("nope", {}, ctx);
  expect(unknown.ok).toBe(false);
  expect(unknown.output).toContain("unknown tool");
});

test("edit_file refuses ambiguous matches", async () => {
  const ctx = { worktree: root, cfg, locked: new Set(["dup.ts"]) };
  await Bun.write(join(root, "dup.ts"), "a\na\n");
  const res = await execTool("edit_file", { path: "dup.ts", old_string: "a", new_string: "b" }, ctx);
  expect(res.ok).toBe(false);
  expect(res.output).toContain("occurs 2 times");
});

// ------------------------------------------------------------------ config

test("config rejects unknown providers and bad versions", async () => {
  const { ConfigSchema: S } = await import("../src/config.ts");
  const bad = S.safeParse({
    config_version: 1,
    providers: { default: { base_url: "not-a-url", secret_ref: "r" } },
    model_routing: { _default: { provider: "default", model: "m" } },
  });
  expect(bad.success).toBe(false);

  const noDefault = S.safeParse({
    config_version: 1,
    providers: { default: { base_url: "http://x", secret_ref: "r" } },
    model_routing: { dev: { provider: "default", model: "m" } },
  });
  expect(noDefault.success).toBe(false);
});

test("nested config defaults are materialised, not left empty", () => {
  expect(cfg.timeouts.llm_request_seconds).toBe(120);
  expect(cfg.budget.max_tokens_per_task).toBe(50_000);
  expect(cfg.tools.allowed.length).toBeGreaterThan(0);
  expect(cfg.tools.network_access).toBe(false);
});
