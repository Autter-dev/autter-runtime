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

test("flush reports false when a target throws synchronously", async () => {
  const failingTarget = {
    forceFlush() {
      throw new Error("sync flush failed");
    },
  };

  const handle = installAutterAutoFlush({
    targets: [failingTarget],
    log: false,
    warnOnUnflushedExit: false,
  });

  const result = await handle.flush("sync-throw");
  handle.dispose();

  assert.equal(result, false);
});

test("flush reports true when all targets fulfill", async () => {
  const firstTarget = {
    forceFlush() {
      return Promise.resolve();
    },
  };

  const secondTarget = {
    forceFlush() {
      return Promise.resolve();
    },
  };

  const handle = installAutterAutoFlush({
    targets: [firstTarget, secondTarget],
    log: false,
    warnOnUnflushedExit: false,
  });

  const result = await handle.flush("success");
  handle.dispose();

  assert.equal(result, true);
});

test("flush reports false when a built-in-style target propagates an exporter rejection", async () => {
  const exporter = {
    forceFlush() {
      return Promise.reject(new Error("exporter failed"));
    },
  };

  const builtInStyleTarget = {
    async forceFlush() {
      const results = await Promise.allSettled([
        exporter.forceFlush(),
        Promise.resolve(),
      ]);

      const failed = results.find((result) => result.status === "rejected");

      if (failed) {
        throw failed.reason;
      }
    },
  };

  const handle = installAutterAutoFlush({
    targets: [builtInStyleTarget],
    log: false,
    warnOnUnflushedExit: false,
  });

  const result = await handle.flush("built-in-style-rejection");
  handle.dispose();

  assert.equal(result, false);
});
