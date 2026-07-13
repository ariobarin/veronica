import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule, resolveListenHosts } from "../src/server.js";

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
