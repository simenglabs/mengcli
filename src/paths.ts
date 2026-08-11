import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const XDG_STATE = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");

export const CONFIG_DIR = process.env.MENGCLI_CONFIG_DIR || join(XDG_CONFIG, "mengcli");
export const STATE_DIR = process.env.MENGCLI_STATE_DIR || join(XDG_STATE, "mengcli");

export const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");
export const SKILLS_DIR = join(CONFIG_DIR, "skills");
export const DB_FILE = join(STATE_DIR, "mengcli.db");

/** Directory holding per-task git worktrees, relative to a repo root. */
export const WORKSPACE_DIRNAME = ".agent_workspace";

export function workspaceDir(repoPath: string): string {
  return join(repoPath, WORKSPACE_DIRNAME);
}

export function taskWorktree(repoPath: string, taskId: string): string {
  return join(workspaceDir(repoPath), taskId);
}

export function ensureDirs(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(SKILLS_DIR, { recursive: true, mode: 0o700 });
}
