import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createGatewayApp, isMainModule, resolveListenHosts } from "../src/server.js";

test("server starts when the entrypoint resolves through a release symlink", () => {
  const symlinkPath = path.resolve("/opt/veronica/current/dist/server.js");
  const releasePath = path.resolve("/opt/veronica/releases/revision/dist/server.js");
  const canonicalize = (value: string) => (value === symlinkPath ? releasePath : value);

  assert.equal(isMainModule(symlinkPath, pathToFileURL(releasePath).href, canonicalize), true);
});

test("listen hosts include distinct loopback and private addresses", () => {
  const previousHosts = process.env.HOSTS;
  const previousHost = process.env.HOST;
  try {
    process.env.HOSTS = "127.0.0.1, 10.0.0.1,127.0.0.1";
    process.env.HOST = "192.0.2.1";
    assert.deepEqual(resolveListenHosts(), ["127.0.0.1", "10.0.0.1"]);
  } finally {
    if (previousHosts === undefined) delete process.env.HOSTS;
    else process.env.HOSTS = previousHosts;
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
  }
});

test("legacy HOST does not widen the default listener", () => {
  const previousHosts = process.env.HOSTS;
  const previousHost = process.env.HOST;
  try {
    delete process.env.HOSTS;
    process.env.HOST = "0.0.0.0";
    assert.deepEqual(resolveListenHosts(), ["127.0.0.1"]);
  } finally {
    if (previousHosts === undefined) delete process.env.HOSTS;
    else process.env.HOSTS = previousHosts;
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
  }
});

function initializeBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" }
    }
  });
}

test("gateway leaves MCP client admission to the transport and protects device routes", async t => {
  const deviceToken = "d".repeat(32);
  const app = createGatewayApp({ deviceToken });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  t.after(() => new Promise<void>((resolve, reject) => listener.close(error => (error ? reject(error) : resolve()))));
  const baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);

  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    },
    body: initializeBody()
  });
  assert.equal(initialize.status, 200);
  assert.equal(initialize.headers.has("www-authenticate"), false);

  const arbitraryBearer = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: "Bearer not-a-veronica-credential"
    },
    body: initializeBody()
  });
  assert.equal(arbitraryBearer.status, 200);

  const deviceDenied = await fetch(`${baseUrl}/device/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "denied", platform: "win32", rootLabel: "repo" })
  });
  assert.equal(deviceDenied.status, 401);

  const deviceAccepted = await fetch(`${baseUrl}/device/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ name: "test", platform: "win32", rootLabel: "repo" })
  });
  assert.equal(deviceAccepted.status, 201);

  const legacyDeviceAccepted = await fetch(`${baseUrl}/device/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ name: "legacy", platform: "win32", hostname: "legacy-host" })
  });
  assert.equal(legacyDeviceAccepted.status, 201);
});
