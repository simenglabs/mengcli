<div align="center">

```
  /\_/\
 ( o.o )   mengCLI
  > ^ <    AI agent by Menglabs
```

**An autonomous multi-agent coding CLI.**
Describe the work, get back a reviewable git branch.

[![npm](https://img.shields.io/npm/v/@menglabs/mengcli?color=cb3837&logo=npm)](https://www.npmjs.com/package/@menglabs/mengcli)
[![CI](https://github.com/simenglabs/mengcli/actions/workflows/ci.yml/badge.svg)](https://github.com/simenglabs/mengcli/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@menglabs/mengcli?color=blue)](./LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-000?logo=bun)](https://bun.sh)

</div>

---

You give it a task. It runs a team of AI agents and hands you a git branch to
review.

Your working tree is never touched. Every task lives in its own `git worktree`
and lands as a branch you merge yourself — or throw away.

Run `mengcli` with no arguments for the interactive shell:

```
╭─────────────────────────────────────────────╮
│ mengCLI  AI agent by Menglabs               │
│                                             │
│ repo   my-project on main                   │
│ model  claude-sonnet-4-6                    │
│ help   /help · submit an empty line to exit │
╰─────────────────────────────────────────────╯

› add pagination to the users endpoint
task 7f3a91c2
branch mengcli/add-pagination-to-the-users-3a91c2
▶ planner started
  ⚙ task_done Paginate with limit/offset, default 25.
✔ planner done
▶ riset started
  ⚙ search_files "users"
✔ riset done
▶ dev started
  ⚙ edit_file src/routes/users.ts
  ⚙ write_file src/db/queries.ts
✔ dev done
  commit 4f2a1b9c
✔ delivered  mengcli/add-pagination-to-the-users-3a91c2  8420 tokens · 6 iterations · 1m12s
  /diff to review · /merge to accept

› /merge
merging mengcli/add-pagination-to-the-users-3a91c2 into main
  src/routes/users.ts
  src/db/queries.ts
proceed? [y/N] y
merged mengcli/add-pagination-to-the-users-3a91c2 → main
```

Tab completes slash commands, `↑` recalls previous prompts, and `Ctrl-C` stops
the running task without leaving the shell.

Prefer one-shot commands, or running in the background? Every slash command has
a subcommand equivalent, and `run` detaches into tmux:

```bash
$ mengcli run "convert the auth middleware to async/await"
started 7f3a91c2  mengcli-b4e27f3a91c2
  follow:  mengcli logs 7f3a91c2
  status:  mengcli status
```

## Install

```bash
npm install -g @menglabs/mengcli
```

Requires **git** and **tmux**. macOS and Linux (Windows via WSL2).

Bun ships with the package, so you do not need to install it separately.

## Quick start

```bash
mengcli config                    # provider, model, API key
mengcli doctor                    # verify everything is wired up

cd ~/code/my-project
mengcli                           # interactive shell
```

Tasks started with `mengcli run` detach immediately — close the terminal, lock
your laptop, they keep running. Check on them whenever:

```bash
mengcli status                    # all tasks and today's token spend
mengcli logs --follow             # attach to the live session
mengcli trace                     # replay every decision the agents made
mengcli diff                      # review the changes
mengcli merge                     # accept them (asks first)
```

IDs may be abbreviated. Omit the ID entirely and the most recent task is used.

## How a task runs

```
prompt ──> planner ──> riset ──> dev ──> commit ──> DELIVERED ──> you merge
              │           │        │
              └───────────┴────────┴──> tools: read, write, edit, search, bash
```

| Team | Role | Writes files |
| --- | --- | :---: |
| **planner** | breaks the request into a concrete, ordered plan | no |
| **riset** | locates relevant code, reports existing conventions | no |
| **dev** | implements the plan and verifies it | yes |

Each team's instructions live in `~/.config/mengcli/skills/<team>/SKILL.md`.
Edit them and the agents follow your version instead of the built-in defaults.

## Safety

Agents run unattended, so the limits are enforced rather than politely requested.

| Guardrail | What it does |
| --- | --- |
| **Never pushes** | Agents may commit and branch. `push`, `merge`, `rebase`, `reset --hard` are blocked. Merging happens only when you ask. |
| **Command allowlist** | Every segment of a pipeline is checked. `curl`, `wget`, `ssh`, `sudo` are refused outright. |
| **Sandboxed paths** | File access cannot escape the task's worktree. |
| **Token budgets** | Per task and per day. Retries are charged too, so a retry loop cannot quietly burn your quota. |
| **Circuit breaker** | Iteration limits stop stuck agents and write an autopsy into the trace. |
| **File locking** | Locks are declared up front and taken in sorted order, making deadlock structurally impossible. Dead agents' locks are reaped by TTL and PID check. |
| **Keychain credentials** | API keys go to macOS Keychain or libsecret, never into `config.yaml`. Logs are redacted before they touch disk. |

## Commands

| Command | Description |
| --- | --- |
| *(none)* / `chat` | open the interactive shell |
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
| `config show` | print the current configuration |
| `init` | prepare the current repository |
| `doctor` | check prerequisites and credentials |

Add `--json` to any command for machine-readable output.

**Exit codes:** `0` ok · `1` error · `2` bad config · `3` budget exceeded ·
`4` circuit breaker · `5` missing prerequisite · `6` task not found

## Configuration

`~/.config/mengcli/config.yaml`, mode `0600`. No credentials live here.

```yaml
config_version: 1

providers:
  default:
    base_url: https://api.anthropic.com
    secret_ref: mengcli/provider/default   # points at the OS keychain
    api: anthropic                         # or: openai

model_routing:
  _default: { provider: default, model: claude-sonnet-4-6 }
  riset:    { provider: default, model: claude-haiku-4-5 }  # cheap model for reading

budget:
  max_tokens_per_task: 50000
  max_iterations_per_task: 15
  max_tokens_per_day: 2000000
  max_concurrent_agents: 3

tools:
  allowed: [git, rg, fd, bun, npm, go, cargo, make]
  network_access: false
```

Any OpenAI-compatible endpoint works — OpenRouter, Groq, Ollama, vLLM.
`MENGCLI_BASE_URL` and `MENGCLI_MODEL` override the defaults for one-off runs.

## Where things live

```
~/.config/mengcli/config.yaml        settings
~/.config/mengcli/skills/            agent instructions you can edit
~/.local/state/mengcli/mengcli.db    tasks, events, locks, budget ledger
<repo>/.agent_workspace/<task>/      per-task git worktree
```

## Development

```bash
git clone https://github.com/simenglabs/mengcli.git
cd mengcli
bun install

bun test                # 24 tests, no network required
bun run typecheck
bun src/index.ts help   # run without installing
```

Tests use a mock provider, so they cost nothing and need no API key.

## Not in this release

Web UI, Telegram remote control, MCP servers, and the security/QA/migration
teams are planned for later versions. The shell is a single scrolling pane; a
split-pane layout with live task panels is on the list too. See [`PRD.md`](./PRD.md) for the full
specification and release scope.

## License

MIT © [Menglabs](https://github.com/simenglabs)
