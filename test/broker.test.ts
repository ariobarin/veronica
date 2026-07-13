import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Broker } from "../src/broker.js";
import { VeronicaError } from "../src/protocol.js";

async function openWorkspace(broker: Broker, deviceId: string, deviceName: string | undefined = "desktop") {
  const opening = broker.openWorkspace(deviceName, "repo");
  const openJob = await broker.pollDevice(deviceId, 0);
  assert.equal(openJob?.request.type, "open_workspace");
  assert.equal(broker.completeJob(deviceId, openJob!.id, { ok: true, value: { path: "repo" } }), true);
  return await opening;
}

test("broker routes workspace jobs to one named device", async () => {
  const broker = new Broker();
  const deviceId = broker.registerDevice("desktop", "linux/x64", "project");
  const workspace = await openWorkspace(broker, deviceId, undefined);

  assert.deepEqual(broker.listDevices()[0], {
    id: deviceId,
    name: "desktop",
    platform: "linux/x64",
    rootLabel: "project",
    online: true,
    lastSeenAt: broker.listDevices()[0]!.lastSeenAt
  });

  const reading = broker.executeInWorkspace(workspace.id, workspacePath => ({
    type: "read_file",
    workspace: workspacePath,
    path: "README.md"
  }));
  const readJob = await broker.pollDevice(deviceId, 0);
  assert.equal(readJob?.request.type, "read_file");
  assert.equal(
    broker.completeJob(deviceId, readJob!.id, { ok: true, value: { content: "hello", sha256: "0".repeat(64) } }),
    true
  );

  assert.deepEqual(await reading, {
    ok: true,
    value: { content: "hello", sha256: "0".repeat(64) }
  });
  assert.equal(broker.closeWorkspace(workspace.id), true);
  assert.equal(broker.closeWorkspace(workspace.id), false);
});

test("broker requires a device name only when selection is ambiguous", async () => {
  const broker = new Broker();
  broker.registerDevice("desktop", "linux/x64", "first");
  broker.registerDevice("laptop", "darwin/arm64", "second");

  await assert.rejects(
    broker.openWorkspace(undefined, "."),
    error =>
      error instanceof VeronicaError &&
      error.code === "conflict" &&
      error.message === "Multiple Veronica devices are online: desktop, laptop"
  );
});

test("broker prunes stale device records after the retention window", () => {
  let now = 1_000;
  const broker = new Broker({
    now: () => now,
    deviceOnlineWindowMs: 100,
    deviceRetentionMs: 500
  });
  broker.registerDevice("desktop", "linux/x64", "project");
  now += 501;
  assert.deepEqual(broker.listDevices(), []);
});

test("broker retains stale devices while a delivered job is pending", async () => {
  let now = 1_000;
  const broker = new Broker({
    now: () => now,
    deviceOnlineWindowMs: 100,
    deviceRetentionMs: 500
  });
  const deviceId = broker.registerDevice("desktop", "linux/x64", "project");
  const opening = broker.openWorkspace("desktop", "repo");
  const job = await broker.pollDevice(deviceId, 0);
  assert.equal(job?.request.type, "open_workspace");

  now += 501;
  assert.equal(broker.listDevices().length, 1);
  assert.equal(broker.completeJob(deviceId, job!.id, { ok: true, value: { path: "repo" } }), true);
  await opening;

  now += 501;
  assert.deepEqual(broker.listDevices(), []);
});

test("broker removes queued jobs when their caller times out", async () => {
  const broker = new Broker();
  const deviceId = broker.registerDevice("desktop", "linux/x64");
  const workspace = await openWorkspace(broker, deviceId);

  const execution = broker.executeInWorkspace(
    workspace.id,
    workspacePath => ({
      type: "read_file",
      workspace: workspacePath,
      path: "README.md"
    }),
    10
  );
  await assert.rejects(
    execution,
    error => error instanceof VeronicaError && error.code === "timeout" && error.message === "Device job timed out"
  );
  assert.equal(await broker.pollDevice(deviceId, 0), null);
  assert.equal(
    broker.completeJob(deviceId, randomUUID(), {
      ok: false,
      error: { code: "operation_failed", message: "late result" }
    }),
    false
  );
});
