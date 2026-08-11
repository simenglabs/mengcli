import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate all state before any module reads the environment.
const root = mkdtempSync(join(tmpdir(), "mengcli-e2e-"));
process.env.MENGCLI_CONFIG_DIR = join(root, "config");
process.env.MENGCLI_STATE_DIR = join(root, "state");
process.env.MENGCLI_DB = join(root, "state", "test.db");
process.env.MENGCLI_SECRET_MENGCLI_PROVIDER_DEFAULT = "test-key";

const { ConfigSchema } = await import("../src/config.ts");
const { createTask, getTask, getEvents, listLocks } = await import("../src/db.ts");
const { executeTask } = await import("../src/runner.ts");
const { run } = await import("../src/git.ts");

const repo = join(root, "repo");

/**
 * Mock provider that walks the three teams through a scripted conversation:
 * planner and riset report findings, dev writes a file, each ends with task_done.
 */
let turn = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { messages: Array<{ content: string }> };
    const system = body.messages[0]?.content ?? "";
    turn++;

    const reply = (calls: unknown[], text = "") =>
      Response.json({
        choices: [{ message: { content: text, tool_calls: calls }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });

    const call = (name: string, args: unknown) => ({
      id: `c${turn}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });

    if (system.includes("Team Planner")) {
      return reply([call("task_done", { summary: "Create greet.ts exporting greet()." })]);
    }
    if (system.includes("Team Riset")) {
      return reply([call("task_done", { summary: "Empty project; TypeScript, no test runner." })]);
    }
    // Team Dev: write on the first turn, finish on the second.
    if (turn <= 3) {
      return reply([
        call("write_file", {
          path: "greet.ts",
          content: "export const greet = (n: string) => `hi ${n}`;\n",
        }),
      ]);
    }
    return reply([call("task_done", { summary: "Added greet.ts", files_changed: ["greet.ts"] })]);
  },
});

beforeAll(async () => {
  const cfg = ConfigSchema.parse({
    config_version: 1,
    providers: {
      default: {
        base_url: `http://localhost:${server.port}/v1`,
        secret_ref: "mengcli/provider/default",
        api: "openai",
      },
    },
    model_routing: { _default: { provider: "default", model: "mock" } },
  });
  const { saveConfig } = await import("../src/config.ts");
  await saveConfig(cfg);

  await run(["mkdir", "-p", repo], root);
  await run(["git", "init", "-q", "-b", "main"], repo);
  await run(["git", "config", "user.email", "t@t"], repo);
  await run(["git", "config", "user.name", "t"], repo);
  await Bun.write(join(repo, "README.md"), "# test\n");
  await run(["git", "add", "-A"], repo);
  await run(["git", "commit", "-qm", "init"], repo);
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("full task lifecycle produces a mergeable branch", async () => {
  const task = createTask("add a greet helper", repo);
  const lines: string[] = [];
  const status = await executeTask(task.id, (l) => lines.push(l));

  expect(status).toBe("DELIVERED");

  const final = getTask(task.id)!;
  expect(final.status).toBe("DELIVERED");
  expect(final.branch).toMatch(/^mengcli\/add-a-greet-helper-/);
  expect(final.tokens_used).toBeGreaterThan(0);

  // The agent's file exists on the branch, not in the user's working tree.
  const wt = join(repo, ".agent_workspace", task.id);
  expect(await Bun.file(join(wt, "greet.ts")).exists()).toBe(true);
  expect(await Bun.file(join(repo, "greet.ts")).exists()).toBe(false);

  // Work was committed.
  const log = await run(["git", "log", "--oneline", "-1"], wt);
  expect(log.stdout).toContain("feat: add a greet helper");

  // Locks are always released, even on the happy path.
  expect(listLocks()).toHaveLength(0);

  // The trace is complete enough to explain what happened.
  const kinds = getEvents(task.id).map((e) => e.kind);
  expect(kinds).toContain("git.branch");
  expect(kinds).toContain("team.handoff");
  expect(kinds).toContain("lock.acquired");
  expect(kinds).toContain("lock.released");
  expect(kinds).toContain("tool.call");
  expect(kinds).toContain("git.commit");

  // All three teams ran.
  const teams = new Set(getEvents(task.id).map((e) => e.team).filter(Boolean));
  expect(teams).toEqual(new Set(["planner", "riset", "dev"]));
});

test("merge moves the change into the user's branch", async () => {
  const { listTasks } = await import("../src/db.ts");
  const task = listTasks({ limit: 1 })[0]!;
  const { mergeBranch, removeWorktree } = await import("../src/git.ts");

  await mergeBranch(repo, task.branch!, "main");
  await removeWorktree(repo, task.id);

  expect(await Bun.file(join(repo, "greet.ts")).exists()).toBe(true);
});
