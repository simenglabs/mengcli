import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = mkdtempSync(join(tmpdir(), "mengcli-resume-"));
const DB = join(root, "resume.db");
process.env.MENGCLI_CONFIG_DIR = join(root, "config");
process.env.MENGCLI_STATE_DIR = join(root, "state");
process.env.MENGCLI_SECRET_MENGCLI_PROVIDER_DEFAULT = "test-key";
beforeEach(() => {
  process.env.MENGCLI_DB = DB;
});
process.env.MENGCLI_DB = DB;

const { ConfigSchema, saveConfig } = await import("../src/config.ts");
const dbmod = await import("../src/db.ts");
const { executeTask } = await import("../src/runner.ts");
const { run, diffStat } = await import("../src/git.ts");

const repo = join(root, "repo");

/**
 * Scripted provider: the dev team asks a question on its first outing and,
 * once resumed, writes two files across two turns.
 */
let phase: "ask" | "work" = "ask";
let workTurn = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { messages: Array<{ content: string }> };
    const sys = body.messages[0]?.content ?? "";
    const user = body.messages[1]?.content ?? "";

    const call = (name: string, args: unknown) => ({
      id: `c${Math.random()}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    const reply = (calls: unknown[]) =>
      Response.json({
        choices: [{ message: { content: "", tool_calls: calls }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      });

    if (sys.includes("Team Planner")) {
      if (phase === "ask") {
        return reply([call("ask_user", { question: "TypeScript or JavaScript?" })]);
      }
      // The clarification must have reached the planner's brief.
      expect(user).toContain("TypeScript please");
      return reply([call("task_done", { summary: "Create a.ts and b.ts." })]);
    }
    if (sys.includes("Team Riset")) {
      return reply([call("task_done", { summary: "Empty repo." })]);
    }
    workTurn++;
    if (workTurn === 1) return reply([call("write_file", { path: "a.ts", content: "export const a = 1;\n" })]);
    if (workTurn === 2) return reply([call("write_file", { path: "b.ts", content: "export const b = 2;\n" })]);
    return reply([call("task_done", { summary: "Added a.ts and b.ts", files_changed: ["a.ts", "b.ts"] })]);
  },
});

beforeAll(async () => {
  await saveConfig(
    ConfigSchema.parse({
      config_version: 1,
      providers: {
        default: {
          base_url: `http://localhost:${server.port}/v1`,
          secret_ref: "mengcli/provider/default",
          api: "openai",
        },
      },
      model_routing: { _default: { provider: "default", model: "mock" } },
    }),
  );

  await run(["mkdir", "-p", repo], root);
  await run(["git", "init", "-q", "-b", "main"], repo);
  await run(["git", "config", "user.email", "t@t"], repo);
  await run(["git", "config", "user.name", "t"], repo);
  await Bun.write(join(repo, "README.md"), "# x\n");
  await run(["git", "add", "-A"], repo);
  await run(["git", "commit", "-qm", "init"], repo);
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("a paused task resumes with the user's answer and no illegal transition", async () => {
  const task = dbmod.createTask("add helpers", repo);

  // First run: the planner asks and the task parks in PAUSED.
  const first = await executeTask(task.id, () => {});
  expect(first).toBe("PAUSED");
  expect(dbmod.getTask(task.id)!.status).toBe("PAUSED");
  expect(dbmod.getTask(task.id)!.reason).toContain("TypeScript or JavaScript");
  expect(dbmod.listLocks()).toHaveLength(0);

  // The user replies; `mengcli reply` stores the answer rather than mutating status.
  phase = "work";
  dbmod.updateTask(task.id, { answer: "TypeScript please" });
  dbmod.logEvent(task.id, { kind: "pause.resolved", summary: "TypeScript please" });

  // Second run: resumes cleanly, no PAUSED -> PLANNING violation.
  const second = await executeTask(task.id, () => {});
  expect(second).toBe("DELIVERED");

  const done = dbmod.getTask(task.id)!;
  expect(done.status).toBe("DELIVERED");
  expect(done.answer).toBeNull(); // consumed on resume
  expect(done.base_sha).toMatch(/^[0-9a-f]{40}$/);
  expect(done.base_branch).toBe("main");

  const kinds = dbmod.getEvents(task.id).map((e) => e.kind);
  expect(kinds).toContain("pause.requested");
  expect(kinds).toContain("pause.resolved");
});

test("diff spans every commit on the branch, not just the last one", async () => {
  const task = dbmod.listTasks({ limit: 1 })[0]!;
  const wt = join(repo, ".agent_workspace", task.id);

  // A second commit on top of the agent's work.
  await Bun.write(join(wt, "c.ts"), "export const c = 3;\n");
  await run(["git", "add", "-A"], wt);
  await run(["git", "commit", "-qm", "second"], wt);

  // Diffing against base_sha must show all three files; HEAD~1 would show one.
  const stat = await diffStat(wt, task.base_sha!);
  expect(stat).toContain("a.ts");
  expect(stat).toContain("b.ts");
  expect(stat).toContain("c.ts");

  const lastOnly = await diffStat(wt, "HEAD~1");
  expect(lastOnly).not.toContain("a.ts");
});

test("an older database gains the new columns without losing rows", () => {
  const legacyPath = join(root, "legacy.db");
  const legacy = new Database(legacyPath, { create: true });
  legacy.run(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, repo_path TEXT NOT NULL,
      branch TEXT, status TEXT NOT NULL, tmux_session TEXT,
      tokens_used INTEGER NOT NULL DEFAULT 0, iterations INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
    );
    INSERT INTO tasks (id, prompt, repo_path, status, created_at, updated_at)
    VALUES ('old-1', 'legacy task', '/r', 'MERGED', 1, 1);
  `);
  legacy.close();

  process.env.MENGCLI_DB = legacyPath;
  dbmod.closeDb();

  const survivor = dbmod.getTask("old-1");
  expect(survivor).not.toBeNull();
  expect(survivor!.prompt).toBe("legacy task");
  expect(survivor!.base_sha).toBeNull();
  expect(survivor!.answer).toBeNull();

  // New writes work against the migrated table.
  dbmod.updateTask("old-1", { base_sha: "abc123" });
  expect(dbmod.getTask("old-1")!.base_sha).toBe("abc123");

  dbmod.closeDb();
  process.env.MENGCLI_DB = DB;
});
