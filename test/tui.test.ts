import { test, expect } from "bun:test";
import { box, fmtElapsed, fmtTokens, table, width } from "../src/ui.ts";

// NO_COLOR keeps the assertions readable; width() must cope either way.
process.env.NO_COLOR = "1";

test("width ignores ANSI escapes", () => {
  expect(width("plain")).toBe(5);
  expect(width("\x1b[32mplain\x1b[0m")).toBe(5);
  expect(width("\x1b[1m\x1b[36mab\x1b[0m")).toBe(2);
});

test("box borders line up regardless of colour", () => {
  const lines = box(["a", "\x1b[32mlonger line\x1b[0m", "bb"]).split("\n");
  const widths = new Set(lines.map(width));
  // Every row, border or body, is the same visible width.
  expect(widths.size).toBe(1);
  expect(lines).toHaveLength(5);
  expect(lines[0]!.startsWith("╭")).toBe(true);
  expect(lines.at(-1)!.startsWith("╰")).toBe(true);
});

test("columns line up even when cells are coloured", () => {
  // Regression: padEnd counted the escape bytes, so "DELIVERED" ran straight
  // into the next column as "DELIVERED600".
  const rows = [
    ["ID", "STATUS", "TOKENS"],
    ["abc", "\x1b[32mDELIVERED\x1b[0m", "600"],
    ["de", "\x1b[31mFAILED\x1b[0m", "12"],
  ];
  const lines = table(rows).split("\n");
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

  // The last column starts at the same visible offset on every row.
  const offsets = plain.map((l) => l.indexOf(l.trimEnd().split(/\s{2,}/).at(-1)!));
  expect(new Set(offsets).size).toBe(1);
  expect(plain[1]).not.toContain("DELIVERED600");
});

test("box survives embedded newlines and overlong lines", () => {
  // Regression: a multi-line HTTP error split the border apart.
  const lines = box(["ok", 'HTTP 401: {\n  "error": {\n    "message": "bad key"', "x".repeat(400)]).split("\n");
  const widths = new Set(lines.map(width));
  expect(widths.size).toBe(1);
  expect(lines[0]!.startsWith("╭")).toBe(true);
  expect(lines.at(-1)!.startsWith("╰")).toBe(true);
  // Nothing wider than the terminal, whatever was passed in.
  expect([...widths][0]!).toBeLessThanOrEqual(Math.max(24, (process.stdout.columns || 80) - 4) + 4);
});

test("token counts stay short", () => {
  expect(fmtTokens(0)).toBe("0");
  expect(fmtTokens(999)).toBe("999");
  expect(fmtTokens(1000)).toBe("1.0k");
  expect(fmtTokens(12345)).toBe("12.3k");
});

test("elapsed time is stable in width and rolls over at a minute", () => {
  expect(fmtElapsed(0)).toBe("0s");
  expect(fmtElapsed(59_000)).toBe("59s");
  expect(fmtElapsed(60_000)).toBe("1m00s");
  expect(fmtElapsed(125_000)).toBe("2m05s");
});
