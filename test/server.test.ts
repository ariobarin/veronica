import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../src/server.js";

test("server starts when the entrypoint resolves through a release symlink", () => {
  const symlinkPath = path.resolve("/opt/veronica/current/dist/server.js");
  const releasePath = path.resolve("/opt/veronica/releases/revision/dist/server.js");
  const canonicalize = (value: string) => (value === symlinkPath ? releasePath : value);

  assert.equal(isMainModule(symlinkPath, pathToFileURL(releasePath).href, canonicalize), true);
});
