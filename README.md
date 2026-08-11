```
  /\_/\
 ( o.o )   mengCLI
  > ^ <    AI agent by Menglabs
```

An autonomous multi-agent coding CLI. You describe the work, it runs a team of
AI agents in a detached tmux session, and you get back a git branch to review.

Nothing is written to your working tree. Every task lives in its own
`git worktree` and lands as a branch you merge yourself.

## Install

```bash
npm install -g mengcli
```

Requires **git** and **tmux**. macOS and Linux only (Windows needs WSL2).

## Quick start

```bash
mengcli config                    # provider, model, API key
cd ~/code/my-project
mengcli run "add pagination to the users endpoint"
```

The task detaches immediately. Check on it whenever:

```bash
mengcli status                    # all tasks, token spend
mengcli logs                      # live output (--follow to attach)
mengcli trace                     # replay every decision the agents made
mengcli diff                      # what changed
mengcli merge                     # accept it (asks first)
```

Task IDs may be abbreviated, and omitting the ID uses the most recent task.

## How a task runs

```
prompt → planner → riset → dev → commit → DELIVERED → you merge
```

| Team | Role | Can write files |
| --- | --- | --- |
| planner | breaks the request into a concrete plan | no |
| riset | locates the relevant code and conventions | no |
| dev | implements the plan | yes |

Each team's instructions live in `~/.config/mengcli/skills/<team>/SKILL.md`.
Edit them and the agents follow your version instead of the defaults.

## Safety

The agents run unattended, so the limits are enforced rather than requested:

- **Never pushes.** Agents can commit and branch. `push`, `merge`, `rebase` and
  `reset --hard` are blocked. Merging happens only when you ask.
- **Command allowlist.** Every segment of a pipeline is checked. Network tools
  (`curl`, `wget`, `ssh`) and `sudo` are refused outright.
- **Sandboxed paths.** File access cannot escape the task's worktree.
- **Token budgets.** Per task and per day. Retries are charged too, so a
  retry loop cannot quietly burn your quota.
- **Circuit breaker.** Iteration limits stop stuck agents and write an autopsy
  into the trace.
- **File locking.** Locks are declared up front and taken in sorted order, so
  deadlock is structurally impossible. Dead agents' locks are reaped by TTL
  and PID check.
- **Credentials in the keychain.** API keys go to macOS Keychain or libsecret
  via `Bun.secrets`, never into `config.yaml`. Logs are redacted before they
  touch disk.

## Commands

| Command | Description |
| --- | --- |
| `run "<prompt>"` | start a task in a detached tmux session |
| `status` | list tasks, locks and today's token spend |
| `logs <id>` | show the live pane (`--follow` to attach) |
| `trace <id>` | replay the agents' decisions |
| `diff <id>` | show the diff (`--stat` for a summary) |
| `merge <id>` | merge the branch (`-y` to skip the prompt) |
| `stop <id>` | kill the session, release locks, cancel |
| `reply <id> "<text>"` | answer a paused task and resume it |
| `clean` | remove worktrees and sessions for finished tasks |
| `config` | set provider, model and API key |
| `doctor` | check prerequisites and credentials |

Add `--json` to any command for machine-readable output.

## Exit codes

`0` ok · `1` error · `2` bad config · `3` budget exceeded ·
`4` circuit breaker · `5` missing prerequisite · `6` task not found

## Configuration

`~/.config/mengcli/config.yaml` (mode `0600`, no credentials inside):

```yaml
config_version: 1
providers:
  default:
    base_url: https://api.anthropic.com
    secret_ref: mengcli/provider/default   # points at the OS keychain
    api: anthropic                          # or: openai
model_routing:
  _default: { provider: default, model: claude-sonnet-4-6 }
  riset:    { provider: default, model: claude-haiku-4-5 }   # cheap model for reading
budget:
  max_tokens_per_task: 50000
  max_iterations_per_task: 15
  max_tokens_per_day: 2000000
tools:
  allowed: [git, rg, fd, bun, npm, go, cargo, make]
  network_access: false
```

Any OpenAI-compatible endpoint works. `MENGCLI_BASE_URL` and `MENGCLI_MODEL`
override the defaults for one-off runs.

## Where things live

```
~/.config/mengcli/config.yaml        settings
~/.config/mengcli/skills/            agent instructions
~/.local/state/mengcli/mengcli.db    tasks, events, locks, budget
<repo>/.agent_workspace/<task>/      per-task git worktree
```

## Not in this release

Web UI, Telegram control, MCP servers, and the security/QA/migration teams are
planned for later versions. See `PRD.md`.

## License

MIT © Menglabs
