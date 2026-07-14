export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 39100;
export const DEFAULT_GATEWAY = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

export function parsePort(value: string, label = "port"): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${label}: ${value}`);
  return port;
}
