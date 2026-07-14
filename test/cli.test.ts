import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  initializeConfig,
  isCliMainModule,
  parseCliCommand,
  parseExposeArgs,
  parseInitArgs,
  resolveExposeRoot
} from "../src/cli.js";

test("CLI routes the default, explicit, gateway, init, and help commands", () => {
  assert.deepEqual(parseCliCommand([]), { kind: "expose", args: [] });
  assert.deepEqual(parseCliCommand(["repo", "--name", "laptop"]), {
    kind: "expose",
    args: ["repo", "--name", "laptop"]
  });
  assert.deepEqual(parseCliCommand(["expose", "repo"]), { kind: "expose", args: ["repo"] });
  assert.deepEqual(parseCliCommand(["gateway"]), { kind: "gateway" });
  assert.deepEqual(parseCliCommand(["init", "worker"]), { kind: "init", args: ["worker"] });
  assert.deepEqual(parseCliCommand(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliCommand(["help"]), { kind: "help" });
  assert.throws(() => parseCliCommand(["gateway", "extra"]), /Unexpected gateway argument/);
});

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

test("CLI combines config defaults with environment and argument overrides", () => {
  assert.deepEqual(
    parseExposeArgs([], {}, "desktop", {
      gateway: "http://configured.test",
      token: "configured-token",
      name: "configured-name"
    }),
    {
      root: undefined,
      name: "configured-name",
      gateway: "http://configured.test",
      token: "configured-token",
      allowBroadRoot: false
    }
  );
  assert.deepEqual(
    parseExposeArgs(
      ["--name", "argument-name"],
      { VERONICA_GATEWAY: "http://environment.test", VERONICA_TOKEN: "environment-token" },
      "desktop",
      { gateway: "http://configured.test", token: "configured-token", name: "configured-name" }
    ),
    {
      root: undefined,
      name: "argument-name",
      gateway: "http://environment.test",
      token: "environment-token",
      allowBroadRoot: false
    }
  );
});

test("CLI uses safe defaults and rejects malformed expose arguments", () => {
  assert.deepEqual(parseExposeArgs([], { VERONICA_TOKEN: "secret" }, "desktop"), {
    root: undefined,
    name: "desktop",
    gateway: "http://127.0.0.1:39100",
    token: "secret",
    allowBroadRoot: false
  });
  assert.throws(() => parseExposeArgs([], {}, "desktop"), /init worker|VERONICA_TOKEN/);
  assert.throws(
    () => parseExposeArgs(["one", "two"], { VERONICA_TOKEN: "secret" }, "desktop"),
    /Unexpected argument/
  );
  assert.throws(
    () => parseExposeArgs(["--unknown"], { VERONICA_TOKEN: "secret" }, "desktop"),
    /Unknown option/
  );
});

test("CLI parses worker and gateway initialization", () => {
  assert.deepEqual(
    parseInitArgs(["worker", "--gateway", "http://gateway.test", "--name", "laptop", "--token-file", "token"]),
    { target: "worker", gateway: "http://gateway.test", name: "laptop", tokenFile: "token" }
  );
  assert.deepEqual(
    parseInitArgs([
      "gateway",
      "--hosts",
      "127.0.0.1,10.0.0.1",
      "--port",
      "39101",
      "--allowed-hosts",
      "localhost,gateway.test"
    ]),
    {
      target: "gateway",
      hosts: ["127.0.0.1", "10.0.0.1"],
      port: 39101,
      allowedHosts: ["localhost", "gateway.test"]
    }
  );
  assert.throws(() => parseInitArgs([]), /init worker|init gateway/);
  assert.throws(() => parseInitArgs(["gateway", "--port", "70000"]), /Invalid port/);
});

test("worker and gateway initialization preserve the other config section", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veronica-cli-init-"));
  const configFile = path.join(directory, "config.json");
  const tokenFile = path.join(directory, "token");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(tokenFile, "worker-secret\n", "utf8");

  const gateway = await initializeConfig(
    { target: "gateway", hosts: ["127.0.0.1"], port: 39100, allowedHosts: ["localhost"] },
    { VERONICA_DEVICE_TOKEN: "d".repeat(32) },
    configFile
  );
  assert.equal(gateway.generatedToken, "d".repeat(32));

  const worker = await initializeConfig(
    { target: "worker", gateway: "http://127.0.0.1:39100", name: "laptop", tokenFile },
    {},
    configFile
  );
  assert.equal(worker.config.gateway?.deviceToken, "d".repeat(32));
  assert.deepEqual(worker.config.worker, {
    token: "worker-secret",
    gateway: "http://127.0.0.1:39100",
    name: "laptop"
  });
  assert.match(await readFile(configFile, "utf8"), /worker-secret/);
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

test("CLI truncates generated root labels to the protocol limit", async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "veronica-cli-label-"));
  const longName = "x".repeat(140);
  const rootInput = path.join(parent, longName);
  await mkdir(rootInput);
  t.after(() => rm(parent, { recursive: true, force: true }));

  const selected = await resolveExposeRoot(rootInput, { cwd: parent });
  assert.equal(selected.label, "x".repeat(128));
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
