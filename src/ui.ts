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

export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cols = rows[0]!.length;
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(...rows.map((r) => Bun.stringWidth(r[i] ?? ""))),
  );
  return rows
    .map((r) =>
      r
        .map((cell, i) => (cell ?? "").padEnd(widths[i]! + 2))
        .join("")
        .trimEnd(),
    )
    .join("\n");
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
