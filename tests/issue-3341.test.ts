// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3341 — executable lock for the STRICT_IR_REASONS "corpus-zero is NOT
// sufficient" rule (`src/codegen/index.ts`, the `STRICT_IR_REASONS` comment).
//
// Background: several `IrFallbackReason` buckets sit at 0 in
// `scripts/ir-fallback-baseline.json`. That baseline is measured against the
// small `website/playground/examples/` corpus ONLY, so corpus-zero does NOT
// mean the reason is unreachable on real code. Promoting a reason into
// `STRICT_IR_REASONS` is a GLOBAL hard error: `planIrCompilation` records EVERY
// non-claimed unit in `selection.fallbacks` (src/ir/select.ts), and the
// promotion loop in `src/codegen/index.ts` reports each matching reason via
// `reportErrorNoNode` — on ALL user code, not just the corpus. So promoting a
// still-reachable reason turns a legitimate legacy fallback into a hard compile
// error and regresses real programs.
//
// Each program below is valid TypeScript that MUST keep compiling. Today each
// one is rejected by the IR selector with the named reason and compiles via the
// legacy fallback. If someone later adds that reason to `STRICT_IR_REASONS`
// while it is still reachable, `compile()` starts emitting a hard error and the
// matching case here fails loudly — which is exactly the point.
//
// Why assert compile-success and NOT the specific fallback reason: the reason
// is a moving target by design. As the #2855-family IR-adoption work lands, a
// construct legitimately stops tripping its reason (e.g. once the IR claims
// `isNaN`, that case no longer trips `external-call`). Compile-success is the
// durable invariant — it stays true whether the function is IR-claimed or
// legacy-lowered, and only goes red on a premature STRICT promotion. The lock
// therefore weakens as adoption progresses but never false-alarms.
//
// `type-resolution-failure` is deliberately absent: it is unreachable (nothing
// PRODUCES it — no `.set(…, "type-resolution-failure")` exists; the only
// occurrences are the `IrFallbackReason` union decl in select.ts and the
// `check:ir-fallbacks` category list), so there is no valid program to pin.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Each case: a valid program the IR currently rejects for `reason`, which the
 *  legacy path must keep compiling. Promoting `reason` to STRICT breaks it. */
const CASES: ReadonlyArray<{ reason: string; why: string; src: string }> = [
  {
    reason: "external-call",
    why: "call to a non-whitelisted external (whitelist is Math.{abs,sqrt,floor,ceil,trunc} + parseInt by design)",
    src: `export function f(x: number): boolean { return isNaN(x); }`,
  },
  {
    reason: "call-graph-closure",
    why: "claimed fn calling a still-direct-only local (bare for(;;) body)",
    src: `function h(): number { let n = 0; for (;;) { n++; if (n > 3) break; } return n; }
export function g(): number { return h(); }`,
  },
  {
    reason: "param-type-not-resolvable",
    why: "union-typed param — not resolvable to one concrete IR primitive",
    src: `export function f(x: number | string): number { return 1; }`,
  },
  {
    reason: "return-type-not-resolvable",
    why: "union return annotation — resolveReturnType yields null",
    src: `export function f(): number | string { return 1; }`,
  },
  {
    reason: "param-shape-rejected",
    why: "optional param (also covers rest / default-initializer params)",
    src: `export function f(x?: number): number { return 1; }`,
  },
  {
    reason: "destructuring-param-complex",
    why: "rest-in-object destructuring param",
    src: `export function f({ a, ...rest }: { a: number; b: number }): number { return a; }`,
  },
  {
    reason: "class-method",
    why: "computed method name (also generator/abstract names, static super, subclass-of-builtin)",
    src: `const k = "m";
export class C { [k](): number { return 1; } }`,
  },
];

describe("#3341 — corpus-zero IR fallback reasons must stay out of STRICT_IR_REASONS", () => {
  for (const { reason, why, src } of CASES) {
    it(`keeps compiling a valid program that trips "${reason}" (${why})`, async () => {
      const result = await compile(src);
      expect(
        result.success,
        `A valid program that trips "${reason}" failed to compile. If this broke because ` +
          `"${reason}" was added to STRICT_IR_REASONS (src/codegen/index.ts), that promotion is ` +
          `premature: the reason is still REACHABLE on valid code, so promoting it turns a ` +
          `legitimate legacy fallback into a hard compile error. A reason may only be promoted ` +
          `once the IR is expected to always claim+lower the construct. See #3341 / #2855.\n` +
          `Errors:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
      ).toBe(true);
    });
  }
});
