import assert from "node:assert/strict";
import test from "node:test";
import { parseInitArgs } from "../src/cli.js";
import { parsePort } from "../src/defaults.js";
import { resolvePort } from "../src/server.js";

test("ports require a complete decimal value", () => {
  assert.equal(parsePort("39100"), 39100);
  for (const value of ["", "0", "65536", "39100foo", " 39100", "+39100", "39.1"]) {
    assert.throws(() => parsePort(value), /Invalid port/);
  }
});

test("gateway init and environment overrides reject malformed ports", () => {
  assert.deepEqual(parseInitArgs(["gateway", "--port", "39100"]), { target: "gateway", port: 39100 });
  assert.throws(() => parseInitArgs(["gateway", "--port", "39100foo"]), /Invalid port/);
  assert.throws(() => resolvePort({ VERONICA_PORT: "39100foo" }), /Invalid VERONICA_PORT/);
  assert.throws(() => resolvePort({ PORT: "39100foo" }), /Invalid VERONICA_PORT/);
});
