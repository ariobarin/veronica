import { stat } from "node:fs/promises";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type DoctorOptions = {
  configPath: string;
  root: string;
  gateway: string;
  gatewayHosts: string[];
  workerToken?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  fetcher?: typeof fetch;
};

async function configChecks(file: string, platform: NodeJS.Platform): Promise<DoctorCheck[]> {
  try {
    const metadata = await stat(file);
    const checks: DoctorCheck[] = [{ name: "config", ok: metadata.isFile(), detail: file }];
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
      return [{ name: "config", ok: true, detail: `not present at ${file}; using environment/defaults` }];
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

export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const major = Number.parseInt((options.nodeVersion ?? process.versions.node).split(".")[0] ?? "0", 10);
  const rootMetadata = await stat(options.root);
  const fetcher = options.fetcher ?? fetch;
  const checks: DoctorCheck[] = [
    {
      name: "Node.js",
      ok: Number.isInteger(major) && major >= 20,
      detail: options.nodeVersion ?? process.versions.node
    },
    ...(await configChecks(options.configPath, options.platform ?? process.platform)),
    { name: "workspace root", ok: rootMetadata.isDirectory(), detail: options.root },
    {
      name: "gateway listeners",
      ok: options.gatewayHosts.every(host => host !== "0.0.0.0" && host !== "::" && host !== "[::]"),
      detail: options.gatewayHosts.join(", ")
    }
  ];
  checks.push(await healthCheck(options.gateway, fetcher));
  checks.push(await workerAuthenticationCheck(options.gateway, options.workerToken, fetcher));
  return checks;
}

export function formatDoctorChecks(checks: DoctorCheck[]): string {
  return checks.map(check => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`).join("\n");
}
