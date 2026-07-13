import assert from "node:assert/strict";
import test from "node:test";
import { Broker } from "../src/broker.js";

test("broker routes workspace jobs to one named device", async () => {
  const broker = new Broker();
  const deviceId = broker.registerDevice("desktop", "linux/x64");

  const opening = broker.openWorkspace("desktop", "repo");
  const openJob = await broker.pollDevice(deviceId, 0);
  assert.equal(openJob?.request.type, "open_workspace");
  broker.completeJob(deviceId, openJob!.id, { ok: true, value: { path: "repo" } });
  const workspace = await opening;

  const reading = broker.executeInWorkspace(workspace.id, workspacePath => ({
    type: "read_file",
    workspace: workspacePath,
    path: "README.md"
  }));
  const readJob = await broker.pollDevice(deviceId, 0);
  assert.equal(readJob?.request.type, "read_file");
  broker.completeJob(deviceId, readJob!.id, { ok: true, value: { content: "hello" } });

  assert.deepEqual(await reading, { ok: true, value: { content: "hello" } });
  assert.equal(broker.closeWorkspace(workspace.id), true);
  assert.equal(broker.closeWorkspace(workspace.id), false);
});
