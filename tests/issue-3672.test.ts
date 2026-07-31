// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3672 — bound the real ESLint `linter.js` graph compile, and make every way
// the probe can fail LOUD.
//
// ## What #3672 originally claimed, and what is actually true
//
// The issue was filed against a 2026-07-26 observation: the resolved 149-file
// graph "exhausts a 2 GB compiler heap", exiting 134 after ~45 minutes with
// `Ineffective mark-compacts near heap limit` and no structured output.
//
// Re-measured on `main` on 2026-07-31 with the *identical* command line and the
// *identical* `--max-old-space-size=2048` cap, that does not reproduce. Four
// runs (three at 2048 MB, one at 8192 MB), single 8-core container, `free -m`
// available 16.4 GB, 1-min load average 4.1 at start:
//
//   | heap cap | wall   | peak RSS | exit | structured report |
//   | 2048 MB  | 12.5 s | 572 MB   |    0 | yes               |
//   | 2048 MB  | 11.6 s | 592 MB   |    0 | yes               |
//   | 2048 MB  | 18.6 s | 633 MB   |    0 | yes               |
//   | 8192 MB  | 16.4 s | 717 MB   |    0 | yes               |
//
// `--trace-gc` over the 8192 MB run: 63 scavenges, 1 mark-compact, peak
// committed heap 439 MB, `average mu = 0.996` — i.e. GC consumed 0.4 % of wall
// time. There is no heap-exhaustion regime on `main` to reduce to a fixture, so
// #3672's "deterministic reduced fixture ... **if one exists**" criterion is
// answered in the negative, with numbers.
//
// ## Why it is fast now: codegen aborts early
//
// The compile does not finish; it aborts after ~12 s on a single hard error,
// a thrown `ProgramAbiInvariantError` from
// `src/codegen/program-abi-class-callable-planning.ts` for ESLint's
// `LazyLoadingRuleMap extends Map`. So this budget is a budget on a compile
// that stops at the current frontier — stated plainly, because a budget that
// looks green only because the work never happened is the exact vacuity this
// issue warns about. CPU attribution of that ~12 s (`--cpu-prof`, self time):
// 54.2 % inside `node_modules/typescript` (parse/bind/check), ~14 % in
// `stat`/`read`/`open` syscalls (module resolution I/O), and ≤ 3.5 % in any
// single `src/` module. The frontier compile is checker- and I/O-bound, not
// codegen-bound.
//
// **When that invariant is fixed, this test is expected to go red**, because
// full codegen will then run for the first time and the budget below is what
// tells us whether it is bounded. Advance the rung, do not widen the budget
// without a fresh measurement.
//
// ## What this test enforces
//
// The budget is *enforced*, not compared against a recorded number: the child
// gets a hard `--max-old-space-size` and a hard wall-clock kill. A breach
// therefore cannot degrade into a pass. The two control rungs prove the
// supervision can actually fail — an OOM-killed child and a timed-out child
// must surface as probe failures, never as compiler diagnostics.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { ESLINT_DEV_DEPENDENCY_SKIP, requireEslintFile, resolveEslintFile } from "./helpers/eslint.js";
import { diagnosticText, EslintGraphProbeFailure, runCompileProjectProbe } from "./helpers/eslint-graph-probe.js";

const ESLINT_LINTER = resolveEslintFile("lib/linter/linter.js");

/**
 * The heap ceiling named in #3672. Deliberately the exact value the issue
 * reported as exhausted, so this test is a direct refutation of that claim
 * rather than a re-measurement under friendlier conditions.
 */
const HEAP_LIMIT_MB = 2048;

/**
 * Wall-clock ceiling. Measured 11.6–18.6 s on an 8-core container under load;
 * 120 s leaves a ~6.5× margin for slower, more contended CI runners while still
 * catching any return to the ~45-minute regime #3672 was filed about.
 */
const WALL_CLOCK_BUDGET_MS = 120_000;

/** Vitest ceiling must sit above the enforced child budget so the child's own kill wins. */
const TEST_TIMEOUT_MS = WALL_CLOCK_BUDGET_MS + 30_000;

const COMPILE_OPTIONS = { allowJs: true, target: "gc", platform: "node" } as const;

const TMP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../.tmp/issue-3672");

function writeFixture(name: string, source: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const path = join(TMP_DIR, name);
  writeFileSync(path, source);
  return path;
}

describe.skipIf(ESLINT_LINTER === null)(
  `#3672 — real ESLint linter.js graph compiles inside an enforced budget ${ESLINT_DEV_DEPENDENCY_SKIP}`,
  () => {
    it(
      "completes inside the enforced 2048 MB / 120 s budget and emits a structured compile/validate split",
      async () => {
        const entry = requireEslintFile(ESLINT_LINTER, "lib/linter/linter.js");
        const outcome = await runCompileProjectProbe({
          entry,
          options: COMPILE_OPTIONS,
          heapLimitMb: HEAP_LIMIT_MB,
          timeoutMs: WALL_CLOCK_BUDGET_MS,
        });

        // Reaching here already proves: normal exit, inside the heap cap,
        // inside the wall-clock cap, and a parseable structured report. Any of
        // those failing rejects with an EslintGraphProbeFailure instead.
        const { report } = outcome;

        // The compile/validate split is recorded even though a semantic blocker
        // still prevents emission — #3672 requires both halves to be present.
        expect(report).toHaveProperty("success");
        expect(report).toHaveProperty("valid");
        expect(report).toHaveProperty("validationError");

        const diagnostics = diagnosticText(report);

        // Current frontier: compile fails, so nothing is emitted and nothing is
        // validated. `valid` is a real observation, not an absent field.
        expect(report.success, diagnostics).toBe(false);
        expect(report.binaryByteLength).toBe(0);
        expect(report.valid).toBe(false);

        // Exactly one hard codegen error stops the build. Pinning the count
        // (not the diagnostic text of all 125 checker notes) makes both a new
        // codegen abort and the fix of this one visible.
        const codegenErrors = report.errors.filter((error) => error.message.startsWith("Codegen error:"));
        expect(
          codegenErrors.map((error) => error.message),
          "the ESLint graph frontier moved — re-measure the budget above and advance this rung",
        ).toHaveLength(1);
        expect(codegenErrors[0]?.message).toContain("inherited class callable");
        expect(codegenErrors[0]?.message).toContain("has no exact defined function for handle");

        // #3656 stays fixed: no dynamic-object-destructuring invariant.
        expect(diagnostics).not.toContain("object destructuring source must be IrType.object or IrType.class");
        // #3657 stays fixed: ambient host calls are no longer unknown functions.
        expect(diagnostics).not.toContain('ir/from-ast: call to unknown function "__host_is_statement"');

        // Resolution is complete apart from the static JSON edge owned by #3655.
        // Phrased so it stays green (vacuously) once #3655 removes the last one,
        // instead of turning into a cross-lane tripwire.
        for (const error of report.errors) {
          if (error.message.includes("Cannot find module")) {
            expect(error.message).toContain("package.json");
          }
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "reports an abnormally exited child as a probe failure, never as a compiler diagnostic",
      async () => {
        // Control: prove the supervision can fail. A child that dies without a
        // structured report — which is what an out-of-memory abort looks like
        // (measured on this graph at a 192 MB cap: SIGABRT, exit code null, no
        // marker, after 11.3 s) — must reject, not resolve.
        const failure = await runCompileProjectProbe({
          entry: "unused",
          options: COMPILE_OPTIONS,
          heapLimitMb: HEAP_LIMIT_MB,
          timeoutMs: WALL_CLOCK_BUDGET_MS,
          rawArgs: ["only-one-argument"],
        }).then(
          () => null,
          (error: unknown) => error,
        );

        expect(failure, "an abnormally exited probe must not resolve").toBeInstanceOf(EslintGraphProbeFailure);
        const probeFailure = failure as EslintGraphProbeFailure;
        expect(probeFailure.kind).toBe("abnormal-exit");
        expect(probeFailure.detail.exitCode).not.toBe(0);
        expect(probeFailure.message).toContain("is NOT a compiler diagnostic");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "reports a child that overruns its wall-clock budget as a timeout, not as a missing diagnostic",
      async () => {
        // Control: the same real graph, given a budget it cannot possibly meet.
        // Measured floor is ~11.6 s, so 750 ms is guaranteed to be exceeded.
        const entry = requireEslintFile(ESLINT_LINTER, "lib/linter/linter.js");
        const failure = await runCompileProjectProbe({
          entry,
          options: COMPILE_OPTIONS,
          heapLimitMb: HEAP_LIMIT_MB,
          timeoutMs: 750,
        }).then(
          () => null,
          (error: unknown) => error,
        );

        expect(failure, "a probe over its wall-clock budget must not resolve").toBeInstanceOf(EslintGraphProbeFailure);
        const probeFailure = failure as EslintGraphProbeFailure;
        expect(probeFailure.kind).toBe("timeout");
        expect(probeFailure.message).toContain("wall-clock budget");
        expect(probeFailure.message).toContain("not a compiler diagnostic");
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/**
 * The deterministic reduction of the frontier above. This is a REPRO, not a
 * fix — it pins the current defective behaviour so whoever owns the fix has an
 * executable six-line case instead of a 149-file npm graph.
 *
 * Root cause, read off `src/codegen/class-bodies.ts`: the inherited-member scan
 * walks `ctx.funcMap` for every key with the textual prefix `${parentName}_`
 * (`parentClassName` is literally `baseExpr.text`, so `extends Map` yields the
 * prefix `Map_`). A separate, ordinary use of the builtin registers host-import
 * entries under exactly those keys, and the scan hands that IMPORT handle to
 * `setProgramAbiInheritedClassCallableAlias` →
 * `ProgramAbiCallableRegistry.observeInheritedAlias`, which requires a DEFINED
 * function (`definedFuncAt`) and throws `ProgramAbiInvariantError` when the
 * handle is in import index space.
 *
 * Measured minimisation (2026-07-31, `origin/main`); the discriminator is the
 * *separate plain use of the builtin*, which is why `extends Map` on its own
 * never reproduced:
 *
 *   subclass + separate plain builtin use  → FAILS (Registry_set, handle 13)
 *   subclass alone, no separate plain use  → compiles clean
 *   `extends Set` + plain `Set` use        → FAILS (Bag_add, handle 13)
 *   plain JS/CJS flavour                   → FAILS identically
 *   `--target standalone` / `--target wasi`→ a DIFFERENT, deliberate #2620
 *                                            "not yet supported" guard fires
 *                                            first, so the standalone lane is
 *                                            protected by design here.
 *
 * In the real ESLint graph the same defect appears as
 * `LazyLoadingRuleMap_has ... handle 676` (direct `linter.js`) and
 * `... handle 590` (package entry) — `LazyLoadingRuleMap extends Map`.
 */
describe("#3672 — reduced repro of the builtin-subclass inherited-alias defect", () => {
  const SUBCLASS_PLUS_PLAIN_USE = `
class Registry extends Map<string, number> {}
const plain = new Map<string, number>();
plain.set("x", 1);
const r = new Registry();
export function test(): number { return (plain.has("x") ? 1 : 0) + (r.has("a") ? 1 : 0); }
`;

  it("aborts codegen when a builtin subclass coexists with a plain use of that builtin", async () => {
    const entry = writeFixture("subclass-plus-plain-use.ts", SUBCLASS_PLUS_PLAIN_USE);
    const result = await compileProject(entry, COMPILE_OPTIONS);

    const codegenErrors = result.errors.filter((error) => error.message.startsWith("Codegen error:"));
    expect(
      codegenErrors.map((error) => error.message),
      "the builtin-subclass inherited-alias defect is fixed — retire this repro and advance the ESLint frontier rung above",
    ).toHaveLength(1);
    expect(codegenErrors[0]?.message).toContain("inherited class callable Registry_set");
    expect(codegenErrors[0]?.message).toContain("has no exact defined function for handle");
    expect(result.success).toBe(false);
  });

  it("compiles cleanly without the separate plain use — isolating the trigger", async () => {
    // Same subclass, same inherited call, no independent `new Map()`. This is
    // the control that makes the rung above non-vacuous: it proves the failure
    // is caused by the builtin's host-import funcMap entries and not merely by
    // subclassing a builtin.
    const entry = writeFixture(
      "subclass-only.ts",
      `
class Registry extends Map<string, number> {
  own(): number { return 1; }
}
const r = new Registry();
export function test(): number { return (r.has("a") ? 1 : 0) + r.own(); }
`,
    );
    const result = await compileProject(entry, COMPILE_OPTIONS);

    const codegenErrors = result.errors.filter((error) => error.message.startsWith("Codegen error:"));
    expect(codegenErrors.map((error) => error.message)).toEqual([]);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  });
});
