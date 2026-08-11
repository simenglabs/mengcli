import { emitKeypressEvents } from "readline";
import { existsSync } from "fs";
import { CONFIG_FILE, SKILLS_DIR, ensureDirs } from "./paths.ts";
import { EXIT, MengError } from "./errors.ts";
import { defaultConfig, loadConfig, configExists, routeFor, saveConfig, setSecret } from "./config.ts";
import { probeProvider } from "./llm.ts";
import { BUILTIN_SKILLS } from "./agent.ts";
import { Spinner, box, c } from "./ui.ts";

/**
 * The configuration wizard: arrow keys to choose, typing to edit, and a live
 * credential check before anything is written.
 *
 * ponytail: repaints in place on a single screen region rather than using the
 * alternate buffer, so the finished config stays in the scrollback. Good enough
 * until a step needs more rows than a small terminal has.
 */

interface Choice {
  label: string;
  hint: string;
  value: string;
}

const PROVIDERS: Choice[] = [
  { label: "Anthropic", hint: "claude-sonnet, claude-haiku", value: "anthropic" },
  { label: "OpenAI", hint: "gpt-4o, o-series", value: "openai" },
  { label: "OpenRouter", hint: "any model, one key", value: "openrouter" },
  { label: "Groq", hint: "fast, OpenAI-compatible", value: "groq" },
  { label: "Ollama", hint: "local, no API key", value: "ollama" },
  { label: "Custom", hint: "any OpenAI-compatible URL", value: "custom" },
];

const PRESETS: Record<string, { url: string; model: string; api: "openai" | "anthropic"; key: boolean }> = {
  anthropic: { url: "https://api.anthropic.com", model: "claude-sonnet-4-6", api: "anthropic", key: true },
  openai: { url: "https://api.openai.com/v1", model: "gpt-4o", api: "openai", key: true },
  openrouter: { url: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5", api: "openai", key: true },
  groq: { url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", api: "openai", key: true },
  ollama: { url: "http://localhost:11434/v1", model: "qwen2.5-coder", api: "openai", key: false },
  custom: { url: "", model: "", api: "openai", key: true },
};

/** Raw-mode key reader shared by every step. */
class Keys {
  private queue: Array<(k: Key) => void> = [];
  private pending: Key[] = [];

  constructor() {
    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str: string, key: Key) => {
      const k = { ...key, sequence: key?.sequence ?? str, str };
      const next = this.queue.shift();
      if (next) next(k);
      else this.pending.push(k);
    });
  }

  next(): Promise<Key> {
    const buffered = this.pending.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((res) => this.queue.push(res));
  }

  close(): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeAllListeners("keypress");
  }
}

interface Key {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
  str?: string;
}

const write = (s: string) => process.stdout.write(s);
const clearLines = (n: number) => n > 0 && write(`\x1b[${n}A\x1b[0J`);

function abort(): never {
  write(c.dim("\ncancelled\n"));
  process.exit(EXIT.OK);
}

/** Arrow-key list. Returns the chosen value. */
async function select(keys: Keys, title: string, choices: Choice[], start = 0): Promise<string> {
  let i = start;
  let drawn = 0;

  const render = () => {
    clearLines(drawn);
    const lines = [c.bold(title)];
    for (const [n, ch] of choices.entries()) {
      const on = n === i;
      lines.push(
        (on ? c.cyan(" ❯ ") : "   ") +
          (on ? c.cyan(ch.label.padEnd(12)) : ch.label.padEnd(12)) +
          c.dim(ch.hint),
      );
    }
    lines.push(c.dim(" ↑↓ move · enter select"));
    write(lines.join("\n") + "\n");
    drawn = lines.length;
  };

  render();
  for (;;) {
    const k = await keys.next();
    if (k.ctrl && k.name === "c") abort();
    if (k.name === "up" || k.name === "k") i = (i - 1 + choices.length) % choices.length;
    else if (k.name === "down" || k.name === "j") i = (i + 1) % choices.length;
    else if (k.name === "return") {
      clearLines(drawn);
      write(`${c.dim(title)} ${c.cyan(choices[i]!.label)}\n`);
      return choices[i]!.value;
    } else continue;
    render();
  }
}

/** Single-line editor. `mask` hides the value for secrets. */
async function input(
  keys: Keys,
  title: string,
  opts: { fallback?: string; mask?: boolean; required?: boolean } = {},
): Promise<string> {
  let buf = "";
  let drawn = 0;
  let error = "";

  const render = () => {
    clearLines(drawn);
    const shown = opts.mask ? "•".repeat(buf.length) : buf;
    const ghost = !buf && opts.fallback ? c.dim(opts.fallback) : "";
    const lines = [
      c.bold(title),
      " " + c.cyan("❯ ") + (shown || ghost) + c.dim("▏"),
      error ? c.red(" " + error) : c.dim(" enter to accept"),
    ];
    write(lines.join("\n") + "\n");
    drawn = lines.length;
  };

  render();
  for (;;) {
    const k = await keys.next();
    if (k.ctrl && k.name === "c") abort();
    if (k.name === "return") {
      const value = buf.trim() || opts.fallback || "";
      if (opts.required && !value) {
        error = "required";
        render();
        continue;
      }
      clearLines(drawn);
      write(`${c.dim(title)} ${c.cyan(opts.mask ? "•".repeat(Math.min(value.length, 12)) : value)}\n`);
      return value;
    }
    if (k.name === "backspace") buf = buf.slice(0, -1);
    else if (k.ctrl && k.name === "u") buf = "";
    else if (k.sequence && !k.ctrl && k.sequence >= " " && k.sequence !== "\x7f") buf += k.sequence;
    else continue;
    error = "";
    render();
  }
}

export async function runWizard(): Promise<number> {
  if (!process.stdin.isTTY) {
    throw new MengError("the configuration wizard needs a terminal", EXIT.BAD_CONFIG);
  }
  ensureDirs();

  const existing = configExists() ? await loadConfig().catch(() => null) : null;

  write(
    box([
      `${c.bold("mengCLI setup")}`,
      "",
      existing ? c.dim("editing the existing configuration") : c.dim("first run — let's connect a model"),
    ]) + "\n\n",
  );

  const keys = new Keys();
  try {
    const which = await select(keys, "Provider", PROVIDERS);
    const preset = PRESETS[which]!;

    const baseUrl = await input(keys, "Base URL", {
      fallback: preset.url || undefined,
      required: true,
    });
    const model = await input(keys, "Model", { fallback: preset.model || undefined, required: true });

    // Ollama and friends need no credential; do not ask for one we will not use.
    let key = "";
    if (preset.key) {
      key = await input(keys, "API key", { mask: true, required: !existing });
    }

    const api: "openai" | "anthropic" = which === "anthropic" ? "anthropic" : "openai";
    const cfg = defaultConfig(baseUrl, model, api);

    if (key) await setSecret("mengcli/provider/default", key);
    await saveConfig(cfg);

    for (const [team, body] of Object.entries(BUILTIN_SKILLS)) {
      const path = `${SKILLS_DIR}/${team}/SKILL.md`;
      if (!existsSync(path)) await Bun.write(path, body + "\n");
    }

    const spin = new Spinner();
    spin.start("checking credentials");
    const err = await probeProvider(routeFor(cfg, "_default").provider, model);
    spin.stop();

    write("\n");
    write(
      box([
        err ? c.yellow("saved, but the provider did not answer") : c.green("ready"),
        "",
        `${c.dim("model")}   ${model}`,
        `${c.dim("config")}  ${CONFIG_FILE}`,
        `${c.dim("skills")}  ${SKILLS_DIR}`,
        ...(err ? ["", c.yellow(err.slice(0, 60))] : []),
      ]) + "\n",
    );
    if (!err) write(c.dim("\nstart working:  mengcli\n"));
    return EXIT.OK;
  } finally {
    keys.close();
  }
}
