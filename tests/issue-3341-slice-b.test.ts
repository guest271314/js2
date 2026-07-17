// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3341 Slice B — activate the STRICT_IR_BUILD_ERRORS promotion vector.
//
// A post-claim IR-build throw (`ir/integration: unknown … ref`) is the
// name-repoint INVARIANT class: when the selector claimed a function, the IR
// builder emits refs by name to entities IT created, so a resolve miss is a
// builder↔finalize desync bug, never an unlowerable program. Before this slice
// such a throw demoted silently to legacy (a "warning" severity); now it is a
// hard compile error so a future desync regression is loud and filable
// (#2855). This exercises the promotion at its narrowest seam —
// `formatIrPathFallbackDiagnostic` — mirroring the tests/issue-1850.test.ts
// pattern, without needing to reintroduce the underlying compiler bug.

import { describe, expect, it } from "vitest";

import { formatIrPathFallbackDiagnostic } from "../src/codegen/index.js";

describe("#3341 Slice B — STRICT_IR_BUILD_ERRORS promotion", () => {
  it("promotes the unknown-function-ref name-repoint invariant to a hard error", () => {
    const diag = formatIrPathFallbackDiagnostic({
      func: "claimed",
      message: 'ir/integration: unknown function ref "__str_concat"',
      kind: "build",
    });
    expect(diag.severity).toBe("error");
    expect(diag.message).toMatch(/^Codegen error: IR path failed for claimed:/);
  });

  it("promotes the unknown-global-ref and unknown-type-ref invariants too", () => {
    for (const message of [
      'ir/integration: unknown global ref "$undefined"',
      'ir/integration: unknown type ref "$Object"',
    ]) {
      const diag = formatIrPathFallbackDiagnostic({ func: "claimed", message, kind: "build" });
      expect(diag.severity).toBe("error");
    }
  });

  it("still demotes an ordinary (non-strict) build error to a warning", () => {
    // A legitimate not-yet-lowerable construct must keep falling back to legacy
    // as a warning — the promotion is scoped to the invariant class only.
    const diag = formatIrPathFallbackDiagnostic({
      func: "claimed",
      message: "ir/from-ast: feature not in slice",
      kind: "build",
    });
    expect(diag.severity).toBe("warning");
    expect(diag.message).toMatch(/^IR path failed for claimed:/);
  });
});
