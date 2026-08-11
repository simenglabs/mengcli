#!/usr/bin/env node
// Node shim: locates the platform Bun binary installed by the `bun` package
// and hands the process over to it. Kept dependency-free and CommonJS so it
// runs on any Node >= 18 without a build step.
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function findBun() {
  // The binary is named `bun.exe` on every platform, including macOS/Linux,
  // so `require.resolve("bun/bin/bun")` does not work.
  try {
    const pkgDir = path.dirname(require.resolve("bun/package.json"));
    const bin = path.join(pkgDir, "bin", "bun.exe");
    if (fs.existsSync(bin)) return bin;
  } catch {
    // fall through to PATH lookup
  }
  // Fallback: a globally installed Bun on PATH.
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], {
    encoding: "utf8",
  });
  const found = (probe.stdout || "").split("\n")[0].trim();
  return found && fs.existsSync(found) ? found : null;
}

if (process.platform === "win32") {
  console.error("mengcli: Windows is not supported (requires tmux). Use WSL2.");
  process.exit(5);
}

const bun = findBun();
if (!bun) {
  console.error(
    "mengcli: could not locate the Bun runtime.\n" +
      "This usually means the package was installed with --ignore-scripts.\n" +
      "Reinstall without it:\n" +
      "  npm install -g mengcli",
  );
  process.exit(5);
}

const entry = path.join(__dirname, "..", "src", "index.ts");
const result = spawnSync(bun, [entry, ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error) {
  console.error("mengcli: failed to start Bun:", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
