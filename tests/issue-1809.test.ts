import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runTest262File } from "./test262-runner.ts";

/**
 * #1809 — the late-import shift walker for object-method / function-decl
 * trampolines wrongly treated a `methodFuncIdx` that legitimately points at a
 * host IMPORT as a "missed shift" and threw at compile time:
 *
 *   Codegen error: pendingMethodTrampolines: methodFuncIdx 30 points at
 *   import "resizeTo" — shift walker missed this entry (#1525b regression)
 *
 * This regressed 157 default-lane test262 tests. The root cause: a value-position
 * reference to a name that resolves through `funcMap` to a host/DOM global
 * (e.g. `resizeTo`, or the `wasm:js-string.length` helper named `length`)
 * registers a cached func-closure trampoline whose target is ALREADY an import.
 * Import indices never shift (new late imports append at the end), so the
 * import target at finalize is EXPECTED — not a missed shift. The guard must
 * only fire when a target that was a DEFINED function resolves to an import.
 *
 * These representative test262 files reproduced the spurious throw before the
 * fix. After the fix they compile to valid Wasm (any residual failure is a
 * separate runtime/harness concern), so the assertion here is narrow: they must
 * no longer surface the `shift walker missed` compile error.
 */
const TEST262_ROOT = resolve(import.meta.dirname, "..", "test262", "test");

const REPRO_FILES = [
  "built-ins/Array/prototype/map/resizable-buffer-grow-mid-iteration.js",
  "built-ins/Array/prototype/reduceRight/resizable-buffer-shrink-mid-iteration.js",
  "language/expressions/class/dstr/gen-meth-static-ary-ptrn-rest-obj-prop-id.js",
  "language/statements/class/dstr/gen-meth-static-ary-ptrn-rest-obj-prop-id.js",
];

describe("#1809 — method-trampoline shift walker must not throw on import funcIdx", () => {
  for (const rel of REPRO_FILES) {
    const abs = resolve(TEST262_ROOT, rel);
    const present = existsSync(abs);
    it.runIf(present)(`${rel} no longer hits the shift-walker assertion`, async () => {
      const r = await runTest262File(abs, "test");
      const detail = (r.reason ?? (r as { error?: string }).error ?? "") as string;
      // The #1525b regression manifested as a compile_error carrying this
      // self-citing message. It must be gone.
      expect(detail).not.toContain("shift walker missed this entry");
      expect(detail).not.toContain("pendingMethodTrampolines");
      // And the test must at least get past compilation (it may still fail at
      // runtime for unrelated, pre-existing reasons — that is out of scope).
      expect(r.status).not.toBe("compile_error");
    });
  }
});
