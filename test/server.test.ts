import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { resolveOAuthConfig } from "../src/auth.js";
import { createGatewayApp, isMainModule, resolveListenHosts } from "../src/server.js";

test("server starts when the entrypoint resolves through a release symlink", () => {
  const symlinkPath = path.resolve("/opt/veronica/current/dist/server.js");
  const releasePath = path.resolve("/opt/veronica/releases/revision/dist/server.js");
  const canonicalize = (value: string) => (value === symlinkPath ? releasePath : value);

  assert.equal(isMainModule(symlinkPath, pathToFileURL(releasePath).href, canonicalize), true);
});

test("listen hosts include distinct loopback and WireGuard addresses", () => {
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

test("legacy host remains a fallback", () => {
  const previousHosts = process.env.HOSTS;
  const previousHost = process.env.HOST;
  try {
    delete process.env.HOSTS;
    process.env.HOST = "127.0.0.2";
    assert.deepEqual(resolveListenHosts(), ["127.0.0.2"]);
  } finally {
    if (previousHosts === undefined) delete process.env.HOSTS;
    else process.env.HOSTS = previousHosts;
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
  }
});

test("gateway separates public OAuth from private device authentication", async t => {
  const oauth = resolveOAuthConfig({
    VERONICA_OAUTH_ISSUER: "https://tenant.example.com/",
    VERONICA_OAUTH_AUDIENCE: "https://veronica.example.com/",
    VERONICA_OAUTH_RESOURCE: "https://veronica.example.com/"
  });
  const verifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token !== "oauth-token" && token !== "read-token") throw new InvalidTokenError("invalid token");
      return {
        token,
        clientId: "chatgpt",
        scopes: token === "read-token" ? ["veronica:read"] : [...oauth.scopes],
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        resource: oauth.resource
      };
    }
  };
  const app = createGatewayApp({ deviceToken: "d".repeat(32), oauth, verifier });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  t.after(() => new Promise<void>((resolve, reject) => listener.close(error => (error ? reject(error) : resolve()))));
  const baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);

  const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {
    resource: "https://veronica.example.com/",
    authorization_servers: ["https://tenant.example.com/"],
    bearer_methods_supported: ["header"],
    scopes_supported: ["veronica:read", "veronica:write"]
  });

  const challenge = await fetch(`${baseUrl}/mcp`, { method: "POST" });
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get("www-authenticate") ?? "", /scope="veronica:read veronica:write"/);
  assert.match(
    challenge.headers.get("www-authenticate") ?? "",
    /resource_metadata="https:\/\/veronica\.example\.com\/\.well-known\/oauth-protected-resource"/
  );

  const deviceTokenOnMcp = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${"d".repeat(32)}` }
  });
  assert.equal(deviceTokenOnMcp.status, 401);

  const insufficientScope = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer read-token" }
  });
  assert.equal(insufficientScope.status, 403);

  const deviceDenied = await fetch(`${baseUrl}/device/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oauth-token" },
    body: JSON.stringify({ name: "test", platform: "win32" })
  });
  assert.equal(deviceDenied.status, 401);

  const deviceAccepted = await fetch(`${baseUrl}/device/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${"d".repeat(32)}` },
    body: JSON.stringify({ name: "test", platform: "win32" })
  });
  assert.equal(deviceAccepted.status, 201);

  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: "Bearer oauth-token"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" }
      }
    })
  });
  assert.equal(initialize.status, 200);
});
