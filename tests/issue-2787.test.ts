// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2787 — Differential-test harness must capture ASYNCHRONOUS console.log
// side-effects.
//
// Top-level corpus code can schedule callbacks (`Promise.resolve().then(...)`,
// `async`/`await`) that call the host `console.log` import *after*
// `__module_init()` returns. Before the fix the harness restored console.log
// immediately after `__module_init()`, so those late writes fired past the
// capture window: they leaked to the real stdout AND the program recorded EMPTY
// output — a false `mismatch` against the V8 oracle. `runJs2wasm` now drains the
// microtask + macrotask job queue inside the capture window (see `drainAsync`),
// so promise/async output is captured. These three programs regressing back to
// empty output is exactly what this test guards.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runJs2wasm } from "../scripts/diff-test.ts";

const CORPUS = resolve(fileURLToPath(import.meta.url), "..", "differential/corpus");

describe("#2787 diff-test harness captures async console.log", () => {
  it("Promise.resolve().then() output is captured (not empty)", async () => {
    const r = await runJs2wasm(resolve(CORPUS, "builtins/07-promise-basic.js"));
    expect(r.outcome).toBe("match");
    expect(r.stdout).toBe("42");
  });

  it("promise chain .then callbacks are captured", async () => {
    const r = await runJs2wasm(resolve(CORPUS, "builtins/08-promise-chain.js"));
    expect(r.outcome).toBe("match");
    expect(r.stdout).toBe("4");
  });

  it("async/await result is captured", async () => {
    const r = await runJs2wasm(resolve(CORPUS, "builtins/09-async-await.js"));
    expect(r.outcome).toBe("match");
    expect(r.stdout).toBe("30");
  });
});
