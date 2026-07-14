import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isCliMainModule, parseExposeArgs } from "../src/cli.js";

test("CLI parses expose options without reading global state", () => {
  assert.deepEqual(
    parseExposeArgs(
      ["repo", "--name", "laptop", "--gateway", "http://gateway.test", "--token", "secret"],
      {},
      "default-host"
    ),
    {
      root: "repo",
      name: "laptop",
      gateway: "http://gateway.test",
      token: "secret"
    }
  );
});

test("CLI uses environment defaults and rejects malformed arguments", () => {
  assert.deepEqual(
    parseExposeArgs([], { VERONICA_GATEWAY: "http://private.test", VERONICA_TOKEN: "secret" }, "desktop"),
    {
      root: ".",
      name: "desktop",
      gateway: "http://private.test",
      token: "secret"
    }
  );
  assert.throws(() => parseExposeArgs([], {}, "desktop"), /Set VERONICA_TOKEN/);
  assert.throws(() => parseExposeArgs(["one", "two"], { VERONICA_TOKEN: "secret" }, "desktop"), /Unexpected argument/);
  assert.throws(() => parseExposeArgs(["--unknown"], { VERONICA_TOKEN: "secret" }, "desktop"), /Unknown option/);
});

test("CLI recognizes a symlinked entrypoint", () => {
  const symlinkPath = path.resolve("/opt/veronica/current/dist/cli.js");
  const releasePath = path.resolve("/opt/veronica/releases/revision/dist/cli.js");
  const canonicalize = (value: string) => (value === symlinkPath ? releasePath : value);

  assert.equal(isCliMainModule(symlinkPath, pathToFileURL(releasePath).href, canonicalize), true);
});
