import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { DEFAULT_DATABASE_URL } from "./db/defaults.ts";
import { z } from "zod";
import { PhoneNumber } from "./schemas.ts";

/** The repo root. One .env lives here for every app (MCP clients launch us from an arbitrary cwd). */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
loadEnv({ path: `${ROOT}.env`, quiet: true });

const Env = z.object({
  AGENTPHONE_API_KEY: z.string().min(1),
  AGENTPHONE_AGENT_ID: z.string().min(1),
  AGENTPHONE_NUMBER_ID: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  USER_PHONE: PhoneNumber,
  CALL_ALLOWLIST: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((n) => n.trim()).filter(Boolean).map((n) => PhoneNumber.parse(n))),
  DATABASE_URL: z.string().url().default(DEFAULT_DATABASE_URL),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  AGENTPHONE_VOICE: z.string().optional(),
  AGENTPHONE_MODEL_TIER: z.enum(["turbo", "balanced", "max", "realtime"]).default("balanced"),
  /** The user's name, used as the default "on behalf of" for requests made by text or voice. */
  USER_NAME: z.string().optional(),
  PORT: z.coerce.number().default(8787),
});
export type Config = z.infer<typeof Env>;

let cached: Config | undefined;
export function getConfig(): Config {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Missing or invalid settings in .env (see .env.example):\n${problems}`);
  }
  return (cached = parsed.data);
}
