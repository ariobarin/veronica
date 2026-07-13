import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isCliMainModule, parseExposeArgs, resolveExposeRoot } from "../src/cli.js";

test("CLI parses explicit expose options without command-line secrets", () => {
  assert.deepEqual(
    parseExposeArgs(
      ["repo", "--name", "laptop", "--gateway", "http://gateway.test", "--allow-broad-root"],
      { VERONICA_TOKEN: "secret" },
      "default-host"
    ),
    {
      root: "repo",
      name: "laptop",
      gateway: "http://gateway.test",
      token: "secret",
      allowBroadRoot: true
    }
  );
  assert.throws(
    () => parseExposeArgs(["--token", "secret"], { VERONICA_TOKEN: "secret" }, "desktop"),
    /Unknown option/
  );
});

test("CLI uses environment defaults and rejects malformed arguments", () => {
  assert.deepEqual(
    parseExposeArgs([], { VERONICA_GATEWAY: "http://private.test", VERONICA_TOKEN: "secret" }, "desktop"),
    {
      root: undefined,
      name: "desktop",
      gateway: "http://private.test",
      token: "secret",
      allowBroadRoot: false
    }
  );
  assert.throws(() => parseExposeArgs([], {}, "desktop"), /Set VERONICA_TOKEN/);
  assert.throws(
    () => parseExposeArgs(["one", "two"], { VERONICA_TOKEN: "secret" }, "desktop"),
    /Unexpected argument/
  );
  assert.throws(
    () => parseExposeArgs(["--unknown"], { VERONICA_TOKEN: "secret" }, "desktop"),
    /Unknown option/
  );
});

test("CLI selects the Git worktree root when no path is provided", async t => {
  const rootInput = await mkdtemp(path.join(os.tmpdir(), "veronica-cli-root-"));
  const nested = path.join(rootInput, "packages", "app");
  await mkdir(nested, { recursive: true });
  t.after(() => rm(rootInput, { recursive: true, force: true }));

  const selected = await resolveExposeRoot(undefined, {
    cwd: nested,
    findGitRoot: async () => rootInput
  });
  assert.deepEqual(selected, {
    root: await realpath(rootInput),
    label: path.basename(await realpath(rootInput)),
    source: "git"
  });
});

test("CLI requires explicit confirmation for broad roots", async t => {
  const rootInput = await mkdtemp(path.join(os.tmpdir(), "veronica-cli-home-"));
  t.after(() => rm(rootInput, { recursive: true, force: true }));

  await assert.rejects(
    resolveExposeRoot(rootInput, { cwd: rootInput, home: rootInput }),
    /Refusing to expose a home or filesystem root/
  );
  const selected = await resolveExposeRoot(rootInput, {
    cwd: rootInput,
    home: rootInput,
    allowBroadRoot: true
  });
  assert.equal(selected.root, await realpath(rootInput));
  assert.equal(selected.source, "explicit");
});

test("CLI allows safe explicit roots when the configured home is missing", async t => {
  const rootInput = await mkdtemp(path.join(os.tmpdir(), "veronica-cli-safe-"));
  t.after(() => rm(rootInput, { recursive: true, force: true }));

  const selected = await resolveExposeRoot(rootInput, {
    cwd: rootInput,
    home: path.join(rootInput, "missing-home")
  });
  assert.equal(selected.root, await realpath(rootInput));
  assert.equal(selected.source, "explicit");
});

test("CLI requires a path outside a Git worktree", async () => {
  await assert.rejects(
    resolveExposeRoot(undefined, {
      findGitRoot: async () => {
        throw new Error("not a repository");
      }
    }),
    /Pass the directory to expose explicitly/
  );
});

test("CLI recognizes a symlinked entrypoint", () => {
  const symlinkPath = path.resolve("/opt/veronica/current/dist/cli.js");
  const releasePath = path.resolve("/opt/veronica/releases/revision/dist/cli.js");
  const canonicalize = (value: string) => (value === symlinkPath ? releasePath : value);

  assert.equal(isCliMainModule(symlinkPath, pathToFileURL(releasePath).href, canonicalize), true);
});
