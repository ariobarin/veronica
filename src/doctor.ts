import { stat } from "node:fs/promises";
import { readConfig } from "./config.js";
import { DEFAULT_HOST, DEFAULT_PORT, parsePort } from "./defaults.js";
import { resolveListenHosts } from "./server.js";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail: string;
};

export type DoctorOptions = {
  configPath: string;
  root: string;
  gateway: string;
  gatewayHosts?: string[];
  workerToken?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
};

async function configChecks(file: string, platform: NodeJS.Platform): Promise<DoctorCheck[]> {
  try {
    const metadata = await stat(file);
    let configCheck: DoctorCheck = { name: "config", ok: metadata.isFile(), detail: file };
    try {
      await readConfig(file);
    } catch (error) {
      configCheck = {
        name: "config",
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
    const checks: DoctorCheck[] = [configCheck];
    if (platform !== "win32") {
      const mode = metadata.mode & 0o777;
      checks.push({
        name: "config permissions",
        ok: (mode & 0o077) === 0,
        detail: `mode ${mode.toString(8).padStart(3, "0")}`
      });
    }
    return checks;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") {
      return [{ name: "config", ok: true, skipped: true, detail: `not present at ${file}; using environment/defaults` }];
    }
    return [{ name: "config", ok: false, detail: error instanceof Error ? error.message : String(error) }];
  }
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: URL,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function healthCheck(gateway: string, fetcher: typeof fetch): Promise<DoctorCheck> {
  try {
    const response = await fetchWithTimeout(fetcher, new URL("/healthz", gateway));
    if (!response.ok) return { name: "gateway health", ok: false, detail: `HTTP ${response.status}` };
    const value = (await response.json()) as { ok?: unknown; service?: unknown };
    const ok = value.ok === true && value.service === "veronica";
    return { name: "gateway health", ok, detail: ok ? gateway : "unexpected health response" };
  } catch (error) {
    return {
      name: "gateway health",
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function workerAuthenticationCheck(
  gateway: string,
  token: string | undefined,
  fetcher: typeof fetch
): Promise<DoctorCheck> {
  if (!token) return { name: "worker authentication", ok: false, detail: "worker token is missing" };
  try {
    const response = await fetchWithTimeout(fetcher, new URL("/device/poll", gateway), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    if (response.status === 400) {
      return { name: "worker authentication", ok: true, detail: "token accepted by gateway" };
    }
    if (response.status === 401 || response.status === 403) {
      return { name: "worker authentication", ok: false, detail: `token rejected with HTTP ${response.status}` };
    }
    return {
      name: "worker authentication",
      ok: false,
      detail: `unexpected HTTP ${response.status}; use the private worker gateway URL`
    };
  } catch (error) {
    return {
      name: "worker authentication",
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function listenerCheck(options: DoctorOptions): Promise<DoctorCheck> {
  const environment = options.environment ?? process.env;
  const configuredByEnvironment =
    environment.VERONICA_HOSTS !== undefined ||
    environment.HOSTS !== undefined ||
    environment.VERONICA_PORT !== undefined ||
    environment.PORT !== undefined;
  let configuredByFile = false;
  if (!configuredByEnvironment) {
    try {
      const gateway = (await readConfig(options.configPath)).gateway;
      configuredByFile = gateway?.hosts !== undefined || gateway?.port !== undefined;
    } catch (error) {
      return {
        name: "gateway listeners",
        ok: false,
        detail: `cannot inspect gateway configuration: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  if (!configuredByEnvironment && !configuredByFile) {
    return {
      name: "gateway listeners",
      ok: true,
      skipped: true,
      detail: "not configured on this machine; inspect the gateway host"
    };
  }
  let hosts: string[];
  try {
    const config = await readConfig(options.configPath);
    hosts = options.gatewayHosts ?? resolveListenHosts(environment, config.gateway);
  } catch (error) {
    return {
      name: "gateway listeners",
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
  return {
    name: "gateway listeners",
    ok: hosts.every(host => host !== "0.0.0.0" && host !== "::" && host !== "[::]"),
    detail: hosts.join(", ")
  };
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export async function resolveDoctorGateway(options: DoctorOptions): Promise<string> {
  const environment = options.environment ?? process.env;
  if (environment.VERONICA_GATEWAY) return environment.VERONICA_GATEWAY;

  let config;
  try {
    config = await readConfig(options.configPath);
  } catch {
    return options.gateway;
  }
  if (config.worker?.gateway) return config.worker.gateway;
  const gatewayConfigured =
    config.gateway !== undefined ||
    environment.VERONICA_HOSTS !== undefined ||
    environment.HOSTS !== undefined ||
    environment.VERONICA_PORT !== undefined ||
    environment.PORT !== undefined;
  if (!gatewayConfigured) return options.gateway;
  const hosts = options.gatewayHosts ?? resolveListenHosts(environment, config.gateway);
  const host = hosts.includes(DEFAULT_HOST) ? DEFAULT_HOST : (hosts[0] ?? DEFAULT_HOST);
  const rawPort = environment.VERONICA_PORT ?? environment.PORT;
  const port = rawPort === undefined ? (config.gateway?.port ?? DEFAULT_PORT) : parsePort(rawPort);
  return `http://${formatHost(host)}:${port}`;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const major = Number.parseInt((options.nodeVersion ?? process.versions.node).split(".")[0] ?? "0", 10);
  const rootMetadata = await stat(options.root);
  const fetcher = options.fetcher ?? fetch;
  let gateway = options.gateway;
  let gatewayConfigurationCheck: DoctorCheck | undefined;
  try {
    gateway = await resolveDoctorGateway(options);
  } catch (error) {
    gatewayConfigurationCheck = {
      name: "gateway configuration",
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
  const checks: DoctorCheck[] = [
    {
      name: "Node.js",
      ok: Number.isInteger(major) && major >= 20,
      detail: options.nodeVersion ?? process.versions.node
    },
    ...(await configChecks(options.configPath, options.platform ?? process.platform)),
    { name: "workspace root", ok: rootMetadata.isDirectory(), detail: options.root },
    await listenerCheck(options)
  ];
  if (gatewayConfigurationCheck) checks.push(gatewayConfigurationCheck);
  checks.push(await healthCheck(gateway, fetcher));
  checks.push(await workerAuthenticationCheck(gateway, options.workerToken, fetcher));
  return checks;
}

export function formatDoctorChecks(checks: DoctorCheck[]): string {
  return checks
    .map(check => `${check.skipped ? "-" : check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`)
    .join("\n");
}
