import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * `mengcli config` is a keyboard-driven wizard, so only a real pty exercises
 * it. The original version read stdin as a stream, which answered the first
 * question and then hung forever, because Response.text() waits for an EOF a
 * terminal never sends. Drive the binary through `expect` and require it to
 * reach the end.
 */
const hasExpect = !!Bun.which("expect");

async function drive(steps: string): Promise<{ out: string; code: number | null; dir: string }> {
  const root = mkdtempSync(join(tmpdir(), "mengcli-wizard-"));
  const script = join(root, "drive.exp");
  const entry = join(import.meta.dir, "..", "src", "index.ts");

  await Bun.write(script, `set timeout 25\nspawn ${process.execPath} ${entry} config\n${steps}\nexpect eof\n`);

  const p = Bun.spawn(["expect", "-f", script], {
    env: {
      ...process.env,
      MENGCLI_CONFIG_DIR: join(root, "config"),
      MENGCLI_STATE_DIR: join(root, "state"),
      MENGCLI_DB: join(root, "state", "t.db"),
      // Keeps the fake credential out of the real keychain.
      MENGCLI_SECRET_MENGCLI_PROVIDER_DEFAULT: "sk-test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return { out, code: p.exitCode, dir: root };
}

test.skipIf(!hasExpect)("the wizard reaches every step and writes a config", async () => {
  const { out, code, dir } = await drive(
    [
      'expect "Provider"',
      "sleep 1",
      // Two downs lands on OpenRouter, proving the list actually moves.
      'send -- "\\033\\[B"',
      "sleep 1",
      'send -- "\\033\\[B"',
      "sleep 1",
      'send -- "\\r"',
      'expect "Base URL"',
      "sleep 1",
      'send -- "\\r"',
      'expect "Model"',
      "sleep 1",
      'send -- "\\r"',
      'expect "API key"',
      "sleep 1",
      'send -- "sk-secret\\r"',
    ].join("\n"),
  );

  const cfg = await Bun.file(join(dir, "config", "config.yaml")).text();
  rmSync(dir, { recursive: true, force: true });

  // Every step was reached; expect exits 1 on timeout, which is the hang.
  expect(out).toContain("Provider");
  expect(out).toContain("Base URL");
  expect(out).toContain("API key");
  expect(code).toBe(0);

  // The arrow keys selected the third provider, and its defaults were applied.
  expect(cfg).toContain("openrouter.ai");
  expect(cfg).toContain("anthropic/claude-sonnet-4.5");

  // The secret is never written to the config file.
  expect(cfg).not.toContain("sk-secret");
  expect(cfg).toContain("secret_ref: mengcli/provider/default");
}, 60_000);

test.skipIf(!hasExpect)("the API key is never echoed to the terminal", async () => {
  const { out, dir } = await drive(
    [
      'expect "Provider"',
      "sleep 1",
      'send -- "\\r"',
      'expect "Base URL"',
      "sleep 1",
      'send -- "\\r"',
      'expect "Model"',
      "sleep 1",
      'send -- "\\r"',
      'expect "API key"',
      "sleep 1",
      'send -- "hunter2secret\\r"',
    ].join("\n"),
  );
  rmSync(dir, { recursive: true, force: true });

  // expect echoes what it sends, so only the reply after the prompt matters.
  const afterPrompt = out.slice(out.indexOf("API key"));
  expect(afterPrompt).not.toContain("hunter2secret");
  expect(afterPrompt).toContain("•");
}, 60_000);
