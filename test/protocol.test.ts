import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TEXT_BYTES, workerRequestSchema } from "../src/protocol.js";

test("worker request limits are shared before jobs reach a device", () => {
  assert.equal(
    workerRequestSchema.safeParse({
      type: "read_file",
      workspace: ".",
      path: "x".repeat(4097)
    }).success,
    false
  );
  assert.equal(
    workerRequestSchema.safeParse({
      type: "run_command",
      workspace: ".",
      command: "x".repeat(100_001),
      timeoutSeconds: 10
    }).success,
    false
  );
  assert.equal(
    workerRequestSchema.safeParse({
      type: "write_file",
      workspace: ".",
      path: "large.txt",
      content: "é".repeat(Math.floor(MAX_TEXT_BYTES / 2) + 1)
    }).success,
    false
  );
});
