import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Broker } from "../src/broker.js";
import { VeronicaError } from "../src/protocol.js";

async function openWorkspace(broker: Broker, deviceId: string) {
  const opening = broker.openWorkspace("desktop", "repo");
  const openJob = await broker.pollDevice(deviceId, 0);
  assert.equal(openJob?.request.type, "open_workspace");
  assert.equal(broker.completeJob(deviceId, openJob!.id, { ok: true, value: { path: "repo" } }), true);
  return await opening;
}

test("broker routes workspace jobs to one named device", async () => {
  const broker = new Broker();
  const deviceId = broker.registerDevice("desktop", "linux/x64");
  const workspace = await openWorkspace(broker, deviceId);

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
      error: { code: "expired", message: "late result" }
    }),
    false
  );
});
