import { existsSync } from "fs";
import { join, relative, resolve } from "path";
import { rm, mkdir, appendFile, readFile } from "fs/promises";
import { WORKSPACE_DIRNAME, taskWorktree, workspaceDir } from "./paths.ts";
import { MengError, EXIT, prereq } from "./errors.ts";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export async function run(cmd: string[], cwd: string, timeoutMs = 120_000): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(9), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code };
  } finally {
    clearTimeout(timer);
  }
}

const git = (args: string[], cwd: string) => run(["git", ...args], cwd);

export async function repoRoot(cwd = process.cwd()): Promise<string> {
  const r = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!r.ok) {
    throw new MengError("not inside a git repository", EXIT.PREREQ, "run: git init");
  }
  return r.stdout;
}

export async function currentBranch(cwd: string): Promise<string> {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return r.ok ? r.stdout : "HEAD";
}

export async function isDirty(cwd: string): Promise<boolean> {
  const r = await git(["status", "--porcelain"], cwd);
  return r.stdout.length > 0;
}

/** Keep the sandbox out of git without touching the user's .gitignore. */
export async function ensureExcluded(repo: string): Promise<void> {
  const excludeFile = join(repo, ".git", "info", "exclude");
  const line = `/${WORKSPACE_DIRNAME}/`;
  try {
    const body = existsSync(excludeFile) ? await readFile(excludeFile, "utf8") : "";
    if (!body.split("\n").includes(line)) {
      await mkdir(join(repo, ".git", "info"), { recursive: true });
      await appendFile(excludeFile, (body.endsWith("\n") || !body ? "" : "\n") + line + "\n");
    }
  } catch {
    /* worktrees keep .git as a file; exclusion is best-effort there */
  }
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

export interface Worktree {
  path: string;
  branch: string;
  baseBranch: string;
  /** Commit the branch was cut from; diffs stay correct if the base moves on. */
  baseSha: string;
}

/**
 * Isolation via `git worktree` rather than a copy: diff/commit/merge stay
 * plain git operations and cleanup is a single command.
 */
export async function createWorktree(
  repo: string,
  taskId: string,
  prompt: string,
): Promise<Worktree> {
  await ensureExcluded(repo);
  const base = await currentBranch(repo);
  const headSha = await git(["rev-parse", "HEAD"], repo);
  if (!headSha.ok) {
    throw new MengError("repository has no commits yet", EXIT.PREREQ, "make an initial commit first");
  }
  const branch = `mengcli/${slugify(prompt)}-${taskId.slice(-6)}`;
  const path = taskWorktree(repo, taskId);
  await mkdir(workspaceDir(repo), { recursive: true });

  const r = await git(["worktree", "add", "-b", branch, path, "HEAD"], repo);
  if (!r.ok) throw new MengError(`git worktree add failed: ${r.stderr}`);
  return { path, branch, baseBranch: base, baseSha: headSha.stdout };
}

export async function removeWorktree(repo: string, taskId: string): Promise<void> {
  const path = taskWorktree(repo, taskId);
  if (!existsSync(path)) return;
  const r = await git(["worktree", "remove", "--force", path], repo);
  if (!r.ok) await rm(path, { recursive: true, force: true });
  await git(["worktree", "prune"], repo);
}

export async function commitAll(worktree: string, message: string): Promise<string | null> {
  const add = await git(["add", "-A"], worktree);
  if (!add.ok) throw new MengError(`git add failed: ${add.stderr}`);
  const status = await git(["status", "--porcelain"], worktree);
  if (!status.stdout) return null; // nothing changed
  const c = await git(["commit", "-m", message, "--no-verify"], worktree);
  if (!c.ok) throw new MengError(`git commit failed: ${c.stderr}`);
  const sha = await git(["rev-parse", "HEAD"], worktree);
  return sha.stdout.slice(0, 12);
}

export async function diffStat(cwd: string, base: string, head = "HEAD"): Promise<string> {
  const r = await git(["diff", "--stat", `${base}..${head}`], cwd);
  return r.stdout;
}

export async function diffFull(cwd: string, base: string, head = "HEAD"): Promise<string> {
  const r = await git(["diff", `${base}..${head}`], cwd);
  return r.stdout;
}

export async function changedFiles(cwd: string, base: string, head = "HEAD"): Promise<string[]> {
  const r = await git(["diff", "--name-only", `${base}..${head}`], cwd);
  return r.stdout ? r.stdout.split("\n") : [];
}

/**
 * Merge is a privileged operation: only ever invoked by the parent process in
 * response to an explicit user command, never by an agent.
 */
export async function mergeBranch(repo: string, branch: string, base: string): Promise<string> {
  if (await isDirty(repo)) {
    throw new MengError(
      "working tree has uncommitted changes; commit or stash before merging",
      EXIT.GENERAL,
    );
  }
  const cur = await currentBranch(repo);
  if (cur !== base) {
    const co = await git(["checkout", base], repo);
    if (!co.ok) throw new MengError(`git checkout ${base} failed: ${co.stderr}`);
  }
  const m = await git(["merge", "--no-ff", branch, "-m", `merge ${branch}`], repo);
  if (!m.ok) {
    await git(["merge", "--abort"], repo);
    throw new MengError(`merge failed and was aborted: ${m.stderr}`);
  }
  return m.stdout;
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(["branch", "-D", branch], repo);
}

/** Reject paths that escape the worktree. */
export function safePath(worktree: string, p: string): string {
  const abs = resolve(worktree, p);
  const rel = relative(worktree, abs);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new MengError(`path escapes the workspace: ${p}`);
  }
  return abs;
}

export async function checkPrereqs(): Promise<void> {
  const missing: string[] = [];
  if (!Bun.which("git")) missing.push("git");
  if (!Bun.which("tmux")) missing.push("tmux");
  if (missing.length) {
    throw prereq(
      `missing required tool(s): ${missing.join(", ")}`,
      process.platform === "darwin"
        ? `install with: brew install ${missing.join(" ")}`
        : `install with: sudo apt install ${missing.join(" ")}`,
    );
  }
}

export function optionalTools(): Record<string, boolean> {
  return {
    rg: !!Bun.which("rg"),
    fd: !!Bun.which("fd"),
    semgrep: !!Bun.which("semgrep"),
    gitleaks: !!Bun.which("gitleaks"),
    dbmate: !!Bun.which("dbmate"),
  };
}
