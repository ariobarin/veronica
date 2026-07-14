import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateDeviceToken } from "./config.js";
import { DEFAULT_HOST } from "./defaults.js";
import { createGatewayApp } from "./server.js";

export type LocalGateway = {
  gatewayUrl: string;
  mcpUrl: string;
  token: string;
  server: Server;
  close: () => Promise<void>;
};

export async function startLocalGateway(): Promise<LocalGateway> {
  const token = generateDeviceToken();
  const app = createGatewayApp({
    deviceToken: token,
    host: DEFAULT_HOST,
    allowedHosts: [DEFAULT_HOST, "localhost"]
  });
  const server = app.listen(0, DEFAULT_HOST);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error("Local gateway did not return a TCP address");
  }
  const gatewayUrl = `http://${DEFAULT_HOST}:${(address as AddressInfo).port}`;
  return {
    gatewayUrl,
    mcpUrl: `${gatewayUrl}/mcp`,
    token,
    server,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  };
}
