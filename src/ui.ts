const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

export const BANNER = String.raw`
  /\_/\
 ( o.o )   mengCLI
  > ^ <    AI agent by Menglabs
`;

export function banner(): void {
  if (process.env.MENGCLI_NO_BANNER) return;
  process.stderr.write(c.cyan(BANNER) + "\n");
}

export function info(msg: string): void {
  process.stderr.write(msg + "\n");
}

export function warn(msg: string): void {
  process.stderr.write(c.yellow("warn: ") + msg + "\n");
}

export function fail(msg: string): void {
  process.stderr.write(c.red("error: ") + msg + "\n");
}

/** Visible width, ignoring the ANSI escapes added by `c`. */
export const width = (s: string) => Bun.stringWidth(s.replace(/\x1b\[[0-9;]*m/g, ""));

export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cols = rows[0]!.length;
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(...rows.map((r) => width(r[i] ?? ""))),
  );
  // padEnd counts the escape bytes, so a coloured cell would get no padding at
  // all; pad against the visible width instead.
  return rows
    .map((r) =>
      r
        .map((cell, i) => (cell ?? "") + " ".repeat(widths[i]! - width(cell ?? "") + 2))
        .join("")
        .trimEnd(),
    )
    .join("\n");
}

/** Round a box around the given lines, ignoring colour when measuring. */
export function box(lines: string[]): string {
  const w = Math.max(...lines.map(width));
  const top = "╭" + "─".repeat(w + 2) + "╮";
  const bottom = "╰" + "─".repeat(w + 2) + "╯";
  const body = lines.map((l) => `│ ${l}${" ".repeat(w - width(l))} │`);
  return c.cyan([top, ...body, bottom].join("\n"));
}

/** "12345" -> "12.3k", so the status line stays a fixed width. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1) + "k";
}

export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A single-line spinner that yields the line whenever something else needs to
 * print, so streamed output never collides with the animation.
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private label = "";
  private readonly enabled = process.stdout.isTTY && !process.env.NO_COLOR;

  start(label: string): void {
    this.label = label;
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.draw(), 80);
    this.timer.unref?.();
    this.draw();
  }

  setLabel(label: string): void {
    this.label = label;
  }

  /** Print above the spinner without leaving a smeared frame behind. */
  print(line: string): void {
    this.clear();
    process.stdout.write(line + "\n");
    if (this.timer) this.draw();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }

  private clear(): void {
    if (this.enabled) process.stdout.write("\r\x1b[2K");
  }

  private draw(): void {
    const f = FRAMES[this.frame++ % FRAMES.length]!;
    process.stdout.write(`\r\x1b[2K${c.cyan(f)} ${this.label}`);
  }
}

/** Relative time, e.g. "3m ago". */
export function ago(ms: number): string {
  const d = Date.now() - ms;
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
