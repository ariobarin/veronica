import { randomBytes } from "node:crypto";
import os from "node:os";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";

const workerConfigSchema = z
  .object({
    gateway: z.string().url().optional(),
    token: z.string().min(1).optional(),
    name: z.string().min(1).optional()
  })
  .strict();

const gatewayConfigSchema = z
  .object({
    deviceToken: z.string().min(32).optional(),
    hosts: z.array(z.string().min(1)).min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    allowedHosts: z.array(z.string().min(1)).min(1).optional()
  })
  .strict();

export const veronicaConfigSchema = z
  .object({
    worker: workerConfigSchema.optional(),
    gateway: gatewayConfigSchema.optional()
  })
  .strict();

export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type VeronicaConfig = z.infer<typeof veronicaConfigSchema>;

export type ConfigPathOptions = {
  environment?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
};

export function resolveConfigPath(options: ConfigPathOptions = {}): string {
  const environment = options.environment ?? process.env;
  const explicit = environment.VERONICA_CONFIG?.trim();
  if (explicit) return path.resolve(explicit);

  const platform = options.platform ?? process.platform;
  if (platform === "win32" && environment.APPDATA) {
    return path.join(environment.APPDATA, "Veronica", "config.json");
  }

  const home = options.home ?? os.homedir();
  const configHome = environment.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return path.join(configHome, "veronica", "config.json");
}

export async function readConfig(file = resolveConfigPath()): Promise<VeronicaConfig> {
  try {
    const raw = await readFile(file, "utf8");
    return veronicaConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error(`Invalid Veronica config JSON at ${file}: ${error.message}`);
    throw error;
  }
}

export async function writeConfig(config: VeronicaConfig, file = resolveConfigPath()): Promise<void> {
  const validated = veronicaConfigSchema.parse(config);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, file);
    if (process.platform !== "win32") await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function generateDeviceToken(): string {
  return randomBytes(32).toString("hex");
}
