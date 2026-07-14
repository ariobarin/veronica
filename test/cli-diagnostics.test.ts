import assert from "node:assert/strict";
import test from "node:test";
import { parseCliCommand, parseDoctorArgs, parseLocalArgs } from "../src/cli.js";

test("CLI routes local and doctor commands", () => {
  assert.deepEqual(parseCliCommand(["local", "repo", "--name", "laptop"]), {
    kind: "local",
    args: ["repo", "--name", "laptop"]
  });
  assert.deepEqual(parseCliCommand(["doctor", "repo"]), { kind: "doctor", args: ["repo"] });
});

test("local mode accepts only workspace selection options", () => {
  assert.deepEqual(parseLocalArgs(["repo", "--name", "laptop", "--allow-broad-root"], "desktop"), {
    root: "repo",
    name: "laptop",
    allowBroadRoot: true
  });
  assert.deepEqual(parseLocalArgs([], "desktop"), {
    root: undefined,
    name: "desktop",
    allowBroadRoot: false
  });
  assert.throws(() => parseLocalArgs(["--gateway", "http://example.test"]), /Unknown local option/);
  assert.throws(() => parseLocalArgs(["one", "two"]), /Unexpected argument/);
});

test("doctor accepts a workspace and broad-root confirmation", () => {
  assert.deepEqual(parseDoctorArgs(["repo", "--allow-broad-root"]), {
    root: "repo",
    allowBroadRoot: true
  });
  assert.deepEqual(parseDoctorArgs([]), { root: undefined, allowBroadRoot: false });
  assert.throws(() => parseDoctorArgs(["--unknown"]), /Unknown doctor option/);
  assert.throws(() => parseDoctorArgs(["one", "two"]), /Unexpected argument/);
});
