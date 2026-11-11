const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

function load(imports = {}) {
  const exports = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync(require.resolve("../src/modules/OperationGate.ts"), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    {
      exports,
      setTimeout,
      clearTimeout,
      require(id) {
        assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`);
        return imports[id];
      },
    },
  );
  return exports;
}

const notices = [];
const gate = load({
  "../utils/locale": { getString: (key) => key },
  "../utils/utils": {
    Utils: { showPopWin: (t, m, type) => notices.push({ t, m, type }) },
  },
});

test("a second operation is refused while the first is running", async () => {
  notices.length = 0;
  let running = 0;
  let overlapped = false;

  let release;
  const first = gate.runExclusive(async () => {
    running++;
    await new Promise((r) => {
      release = r;
    });
    running--;
  });

  // Give the first task a tick to enter.
  await new Promise((r) => setImmediate(r));

  const second = await gate.runExclusive(async () => {
    if (running > 0) overlapped = true;
  });

  release();
  await first;

  assert.equal(second, false, "second call should be refused");
  assert.equal(overlapped, false, "second task must not run concurrently");
  assert.equal(notices.length, 1, "user is told the plugin is busy");
});

test("the lock is released when the task throws", async () => {
  await assert.rejects(
    gate.runExclusive(async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(gate.isPluginBusy(), false);

  let ran = false;
  const ok = await gate.runExclusive(async () => {
    ran = true;
  });
  assert.equal(ok, true);
  assert.equal(ran, true);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the busy notice names the running operation", async () => {
  notices.length = 0;
  let release;
  const first = gate.runExclusive(
    () =>
      new Promise((r) => {
        release = r;
      }),
    { label: "Fetch PDF", maxDurationMs: 0 },
  );
  await delay(10);

  const refused = await gate.runExclusive(async () => {}, {
    maxDurationMs: 0,
  });
  release();
  await first;

  assert.equal(refused, false);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].m, "popwin-busy-hint-detail");
});

test("a stale lock is released by the watchdog", async () => {
  notices.length = 0;
  let release;
  const stuck = gate.runExclusive(
    () =>
      new Promise((r) => {
        release = r;
      }),
    { label: "stuck", maxDurationMs: 25 },
  );
  await delay(60);

  assert.equal(gate.isPluginBusy(), false, "watchdog should release the lock");
  assert.ok(
    notices.some((n) => n.t === "popwin-gate-stale-title"),
    "the user is told the lock was released",
  );

  let ran = false;
  const ok = await gate.runExclusive(
    async () => {
      ran = true;
    },
    { maxDurationMs: 0 },
  );
  assert.equal(ok, true);
  assert.equal(ran, true);

  release();
  await stuck;
  assert.equal(gate.isPluginBusy(), false);
});

test("a stale task finishing late cannot release a newer lock", async () => {
  let releaseStale;
  const stale = gate.runExclusive(
    () =>
      new Promise((r) => {
        releaseStale = r;
      }),
    { maxDurationMs: 20 },
  );
  await delay(45);
  assert.equal(gate.isPluginBusy(), false);

  let releaseNew;
  const fresh = gate.runExclusive(
    () =>
      new Promise((r) => {
        releaseNew = r;
      }),
    { maxDurationMs: 0 },
  );
  await delay(10);
  assert.equal(gate.isPluginBusy(), true);

  // The stale task finally settles while the new one holds the lock.
  releaseStale();
  await stale;
  await delay(10);
  assert.equal(
    gate.isPluginBusy(),
    true,
    "the stale completion must not unlock the newer operation",
  );

  releaseNew();
  await fresh;
  assert.equal(gate.isPluginBusy(), false);
});
