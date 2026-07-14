import assert from "node:assert/strict";
import test from "node:test";
import { startLocalGateway } from "../src/local.js";

test("local gateway binds to loopback with an ephemeral worker token", async t => {
  const gateway = await startLocalGateway();
  t.after(() => gateway.close());

  assert.match(gateway.gatewayUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(gateway.mcpUrl, `${gateway.gatewayUrl}/mcp`);
  assert.match(gateway.token, /^[0-9a-f]{64}$/);

  const health = await fetch(`${gateway.gatewayUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "veronica" });
});
