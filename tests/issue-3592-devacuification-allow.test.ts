import { describe, expect, it } from "vitest";
import {
  evaluateDevacuificationAllowance,
  evaluateTrapCategoryGrowth,
  isDevacuificationExcusableFlip,
  isDispatcherIntroducedTrap,
  trapInnermostFrame,
} from "../scripts/diff-test262.ts";

// #3592 — the ONE-TIME standalone de-vacuification allowance. RC2 fixed
// `__apply_closure` to dispatch at max(argc, declaredArity); previously an
// under-applied call through the closure-dispatch bridge silently never
// happened, so 18.9 % of sampled standalone passes were vacuous. The fix flips
// those fake passes into honest fails, which the #1897 guard would read as a
// mass regression against the pre-fix baseline. These tests pin the properties
// that keep the declared excusal from becoming a general escape hatch.

const TRAP_MSG =
  "RuntimeError: illegal cast in __closure_57() at source L618 (via __closure_50@L507 ← __call_fn_method_3@L24 ← __apply_closure@L622)";
const DISPATCHER_TRAP_MSG =
  "RuntimeError: illegal cast in __call_fn_method_3() at source L24 (via __apply_closure@L622)";

describe("#3592 innermost-frame trap classifier", () => {
  it("extracts the innermost (leaf) frame, not a via-chain frame", () => {
    expect(trapInnermostFrame(TRAP_MSG)).toBe("__closure_57");
    expect(trapInnermostFrame(DISPATCHER_TRAP_MSG)).toBe("__call_fn_method_3");
  });

  it("tolerates a CI line prefix before the message", () => {
    expect(trapInnermostFrame(`L42: ${TRAP_MSG}`)).toBe("__closure_57");
  });

  it("returns null for a frameless message", () => {
    expect(trapInnermostFrame("RuntimeError: unreachable")).toBeNull();
    expect(trapInnermostFrame(undefined)).toBeNull();
  });

  it("classifies dispatcher-innermost as INTRODUCED and user-closure-innermost as pre-existing", () => {
    expect(isDispatcherIntroducedTrap(DISPATCHER_TRAP_MSG)).toBe(true);
    // __call_fn_method_3 appearing OUTWARD in the chain does not make it introduced.
    expect(isDispatcherIntroducedTrap(TRAP_MSG)).toBe(false);
  });
});

describe("#3592 isDevacuificationExcusableFlip", () => {
  it("excuses an ordinary honest assertion failure (pass → fail)", () => {
    expect(
      isDevacuificationExcusableFlip({
        to: "fail",
        error: "Test262Error: Expected SameValue(«1», «2») to be true",
        error_category: "assertion_fail",
      }),
    ).toBe(true);
  });

  it("excuses a verified unmasked pre-existing trap (non-dispatcher innermost frame)", () => {
    expect(isDevacuificationExcusableFlip({ to: "fail", error: TRAP_MSG, error_category: "illegal_cast" })).toBe(true);
  });

  it("REFUSES a dispatcher-introduced trap — that is the #3592 §5 real blocker, not an unmasking", () => {
    expect(
      isDevacuificationExcusableFlip({
        to: "fail",
        error: DISPATCHER_TRAP_MSG,
        error_category: "illegal_cast",
      }),
    ).toBe(false);
  });

  it("REFUSES a frameless trap — an unverifiable claim is not excused", () => {
    expect(
      isDevacuificationExcusableFlip({
        to: "fail",
        error: "RuntimeError: unreachable",
        error_category: "unreachable",
      }),
    ).toBe(false);
  });

  it("REFUSES pass → compile_error / absent — only fail flips qualify", () => {
    expect(isDevacuificationExcusableFlip({ to: "compile_error", error: "invalid Wasm binary" })).toBe(false);
    expect(isDevacuificationExcusableFlip({ to: "absent" })).toBe(false);
  });
});

describe("#3592 evaluateDevacuificationAllowance", () => {
  const allowance = (count: number) => ({
    count,
    reason: "#3592 RC2 arity de-vacuification (measured 18.9% of sampled standalone passes vacuous)",
    sources: ["plan/issues/3592-standalone-vacuous-asserts-arity-and-toplevel-throw.md"],
  });

  const candidates = [
    { file: "a.js", to: "fail", error: "Test262Error: nope", error_category: "assertion_fail" },
    { file: "b.js", to: "fail", error: TRAP_MSG, error_category: "illegal_cast" },
    { file: "c.js", to: "compile_error", error: "invalid Wasm binary", error_category: "wasm_compile" },
    { file: "d.js", to: "fail", error: DISPATCHER_TRAP_MSG, error_category: "illegal_cast" },
  ];

  it("excuses qualifying flips within the ceiling; traps go to the ratchet-exclusion subset", () => {
    const r = evaluateDevacuificationAllowance({ allowance: allowance(10), candidates });
    expect(r.failures).toEqual([]);
    expect([...r.excusedFiles].sort()).toEqual(["a.js", "b.js"]);
    expect([...r.trapExcludedFiles]).toEqual(["b.js"]);
    expect(r.notes.join("\n")).toMatch(/excused 2 of ceiling 10/);
  });

  it("never excuses compile_error or dispatcher-introduced traps", () => {
    const r = evaluateDevacuificationAllowance({ allowance: allowance(10), candidates });
    expect(r.excusedFiles.has("c.js")).toBe(false);
    expect(r.excusedFiles.has("d.js")).toBe(false);
  });

  it("HARD-FAILS above the ceiling and excuses NOTHING — a ceiling, not a blank check", () => {
    const r = evaluateDevacuificationAllowance({ allowance: allowance(1), candidates });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/ceiling exceeded/);
    expect(r.excusedFiles.size).toBe(0);
    expect(r.trapExcludedFiles.size).toBe(0);
  });
});

describe("#3592 trap ratchet excludeFiles integration", () => {
  type Row = { status: string; error_category?: string; wasm_sha?: string | null };
  const rows = (entries: [string, Row][]) => new Map<string, Row>(entries);

  const baseline = rows([
    ["unmasked.js", { status: "pass", wasm_sha: "aaa" }],
    ["introduced.js", { status: "pass", wasm_sha: "bbb" }],
  ]);
  const candidate = rows([
    ["unmasked.js", { status: "fail", error_category: "illegal_cast", wasm_sha: "a2" }],
    ["introduced.js", { status: "fail", error_category: "illegal_cast", wasm_sha: "b2" }],
  ]);

  it("an excluded (verified pre-existing) trap does not grow the category; an unexcluded one still fails", () => {
    const growth = evaluateTrapCategoryGrowth(baseline, candidate, 0, {
      missingBaselineRowsAreUnknown: true,
      excludeFiles: new Set(["unmasked.js"]),
    });
    expect(growth.newCounts.illegal_cast).toBe(1);
    expect(growth.newlyTrapping.illegal_cast).toEqual(["introduced.js"]);
    expect(growth.failures).toHaveLength(1);
    expect(growth.failures[0]).toMatch(/introduced\.js/);
    expect(growth.failures[0]).not.toMatch(/unmasked\.js/);
  });

  it("an empty exclusion set is byte-identical to pre-#3592 behaviour", () => {
    const growth = evaluateTrapCategoryGrowth(baseline, candidate, 0, { missingBaselineRowsAreUnknown: true });
    expect(growth.newCounts.illegal_cast).toBe(2);
    expect(growth.failures).toHaveLength(1);
  });
});

describe("#3592 frontmatter parsing of standalone-devacuification-allow", () => {
  it("parses count + reason via the shared change-scope reader", async () => {
    const { parseFrontmatterCountReason } = await import("../scripts/lib/change-scope.mjs");
    const d = parseFrontmatterCountReason(
      ["---", "id: 3592", "standalone-devacuification-allow:", "  count: 6000", '  reason: "why"', "---"].join("\n"),
      "standalone-devacuification-allow",
    );
    expect(d).toMatchObject({ count: 6000, reason: "why" });
  });
});
