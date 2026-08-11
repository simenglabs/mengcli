import { z } from "zod";
import { chmodSync, existsSync } from "fs";
import { CONFIG_FILE, ensureDirs } from "./paths.ts";
import { badConfig } from "./errors.ts";

export const CONFIG_VERSION = 1;

const ModelRef = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

const Provider = z.object({
  base_url: z.string().url(),
  secret_ref: z.string().min(1),
  /** Wire format. `anthropic` uses /v1/messages, `openai` uses /chat/completions. */
  api: z.enum(["openai", "anthropic"]).default("openai"),
});

const McpServer = z.object({
  name: z.string().min(1),
  transport: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().url().optional(),
  secret_ref: z.string().optional(),
  allowed_tools: z.array(z.string()).default([]),
  auto_approve: z.boolean().default(false),
});

export const ConfigSchema = z.object({
  config_version: z.number().int(),

  providers: z.record(z.string(), Provider).refine((p) => Object.keys(p).length > 0, {
    message: "at least one provider is required",
  }),

  model_routing: z
    .record(z.string(), ModelRef)
    .refine((r) => "_default" in r, { message: "model_routing._default is required" }),

  budget: z
    .object({
      max_tokens_per_task: z.number().int().positive().default(50_000),
      max_iterations_per_task: z.number().int().positive().default(15),
      max_tokens_per_day: z.number().int().positive().default(2_000_000),
      max_concurrent_agents: z.number().int().positive().default(3),
    })
    .prefault({}),

  timeouts: z
    .object({
      llm_request_seconds: z.number().int().positive().default(120),
      tool_call_seconds: z.number().int().positive().default(300),
      stateful_pause_hours: z.number().int().positive().default(24),
      file_lock_seconds: z.number().int().positive().default(600),
    })
    .prefault({}),

  telegram: z
    .object({
      enabled: z.boolean().default(false),
      token_ref: z.string().default("mengcli/telegram/token"),
      allowed_chat_ids: z.array(z.number().int()).default([]),
      require_confirmation_for: z.array(z.string()).default(["merge", "push", "delete"]),
    })
    .prefault({}),

  tools: z
    .object({
      allowed: z
        .array(z.string())
        .default(["git", "rg", "fd", "bun", "npm", "pnpm", "go", "cargo", "make"]),
      denied_args: z.record(z.string(), z.array(z.string())).default({
        git: ["push", "reset --hard", "clean -fdx"],
      }),
      network_access: z.boolean().default(false),
    })
    .prefault({}),

  mcp_servers: z.array(McpServer).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof Provider>;

/** Cross-field checks zod cannot express inline. */
function validateRefs(cfg: Config): void {
  for (const [team, ref] of Object.entries(cfg.model_routing)) {
    if (!cfg.providers[ref.provider]) {
      throw badConfig(
        `model_routing.${team} references unknown provider "${ref.provider}"`,
        `known providers: ${Object.keys(cfg.providers).join(", ")}`,
      );
    }
  }
}

/** Env overrides: MENGCLI_BASE_URL / MENGCLI_MODEL apply to the default provider. */
function applyEnv(cfg: Config): Config {
  const base = process.env.MENGCLI_BASE_URL;
  const model = process.env.MENGCLI_MODEL;
  const def = cfg.model_routing._default!;
  if (base && cfg.providers[def.provider]) cfg.providers[def.provider]!.base_url = base;
  if (model) def.model = model;
  return cfg;
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export async function loadConfig(): Promise<Config> {
  if (!configExists()) {
    throw badConfig(`no config at ${CONFIG_FILE}`, "run: mengcli config");
  }
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(await Bun.file(CONFIG_FILE).text());
  } catch (e) {
    throw badConfig(`${CONFIG_FILE} is not valid YAML: ${(e as Error).message}`);
  }

  const version = (raw as { config_version?: unknown })?.config_version;
  if (version !== CONFIG_VERSION) {
    throw badConfig(
      `config_version ${String(version)} is not supported (expected ${CONFIG_VERSION})`,
      "run: mengcli config migrate",
    );
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw badConfig(`invalid config at ${CONFIG_FILE}\n${lines.join("\n")}`);
  }

  const cfg = applyEnv(parsed.data);
  validateRefs(cfg);
  return cfg;
}

export async function saveConfig(cfg: Config): Promise<void> {
  ensureDirs();
  await Bun.write(CONFIG_FILE, Bun.YAML.stringify(cfg, null, 2));
  chmodSync(CONFIG_FILE, 0o600); // credentials live in the keychain, but be strict anyway
}

/** Resolve the provider + model for a team, falling back to `_default`. */
export function routeFor(cfg: Config, team: string): { provider: ProviderConfig; model: string } {
  const ref = cfg.model_routing[team] ?? cfg.model_routing._default!;
  const provider = cfg.providers[ref.provider];
  if (!provider) throw badConfig(`unknown provider "${ref.provider}" for team "${team}"`);
  return { provider, model: ref.model };
}

/** API keys never touch config.yaml; they live in the OS keychain. */
export async function getSecret(ref: string): Promise<string | null> {
  const envKey = "MENGCLI_SECRET_" + ref.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  if (process.env[envKey]) return process.env[envKey]!;
  try {
    return await Bun.secrets.get({ service: "mengcli", name: ref });
  } catch {
    return null;
  }
}

export async function setSecret(ref: string, value: string): Promise<void> {
  await Bun.secrets.set({ service: "mengcli", name: ref, value });
}

export async function deleteSecret(ref: string): Promise<void> {
  try {
    await Bun.secrets.delete({ service: "mengcli", name: ref });
  } catch {
    /* already absent */
  }
}

export function defaultConfig(baseUrl: string, model: string, api: "openai" | "anthropic"): Config {
  return ConfigSchema.parse({
    config_version: CONFIG_VERSION,
    providers: {
      default: { base_url: baseUrl, secret_ref: "mengcli/provider/default", api },
    },
    model_routing: {
      _default: { provider: "default", model },
    },
  });
}
