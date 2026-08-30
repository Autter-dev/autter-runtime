import test from "node:test";
import assert from "node:assert/strict";
import { installAutterAutoFlush } from "../dist/index.js";

test("flush reports false when a target rejects", async () => {
  const failingTarget = {
    forceFlush() {
      return Promise.reject(new Error("flush failed"));
    },
  };

  const handle = installAutterAutoFlush({
    targets: [failingTarget],
    log: false,
    warnOnUnflushedExit: false,
  });

  const result = await handle.flush("reproduction");
  handle.dispose();

  assert.equal(result, false);
});
