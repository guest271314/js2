// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1845 — IR type-propagation soundness for `&&` / `||`.
//
// `a && b` / `a || b` evaluate to one of the OPERAND VALUES (ECMAScript
// §13.13/§13.14 ShortCircuit), not a coerced boolean. The previous rule
// (`boolCompatible(l) && boolCompatible(r) ? BOOL : DYNAMIC`) over-claimed
// `BOOL` because `boolCompatible` also accepts `unknown` — so an unresolved
// (possibly non-boolean) operand was seeded as `bool`, and `lowerBinary`
// would then emit `i32.and`/`i32.or` on a non-integer value.
//
// New rule: `BOOL` only when both operands are concretely `bool`; otherwise
// the result is `join(l, r)` of the two concrete operand values, and
// `unknown`/`dynamic` on either side falls to `DYNAMIC`.

import { describe, expect, it } from "vitest";
import * as ts from "typescript";

import { _internals, type LatticeType } from "../src/ir/propagate.js";

const { inferExpr, F64, BOOL, UNKNOWN, DYNAMIC } = _internals;

function inferLogical(exprSrc: string, params: ReadonlyArray<{ name: string; type: LatticeType }>): LatticeType {
  const paramList = params.map((p) => `${p.name}: number`).join(", ");
  const sourceText = `function _wrap(${paramList}) { return ${exprSrc}; }`;
  const sf = ts.createSourceFile("_wrap.ts", sourceText, ts.ScriptTarget.Latest, true);
  const fn = sf.statements[0];
  if (!ts.isFunctionDeclaration(fn) || !fn.body) throw new Error("test setup: bad source");
  const stmt = fn.body.statements[0];
  if (!stmt || !ts.isReturnStatement(stmt) || !stmt.expression) throw new Error("test setup: no return");
  const scope = new Map<string, LatticeType>();
  for (const p of params) scope.set(p.name, p.type);
  return inferExpr(stmt.expression, scope, new Map());
}

describe("#1845 — && / || propagation soundness", () => {
  it("infers BOOL when both operands are concretely bool", () => {
    expect(
      inferLogical("a && b", [
        { name: "a", type: BOOL },
        { name: "b", type: BOOL },
      ]),
    ).toEqual(BOOL);
    expect(
      inferLogical("a || b", [
        { name: "a", type: BOOL },
        { name: "b", type: BOOL },
      ]),
    ).toEqual(BOOL);
  });

  it("does NOT over-claim BOOL when an operand is unknown", () => {
    // The regression: `boolCompatible(unknown)` was true, so this returned
    // BOOL — seeding a possibly-non-boolean value as bool. Must be DYNAMIC.
    expect(
      inferLogical("a && b", [
        { name: "a", type: UNKNOWN },
        { name: "b", type: BOOL },
      ]),
    ).toEqual(DYNAMIC);
    expect(
      inferLogical("a || b", [
        { name: "a", type: BOOL },
        { name: "b", type: UNKNOWN },
      ]),
    ).toEqual(DYNAMIC);
    expect(
      inferLogical("a && b", [
        { name: "a", type: UNKNOWN },
        { name: "b", type: UNKNOWN },
      ]),
    ).toEqual(DYNAMIC);
  });

  it("joins concrete numeric operands instead of dropping to DYNAMIC", () => {
    // Both f64 → the result is one of two f64 values, so the sound (and
    // tighter) type is F64. The old rule returned DYNAMIC here.
    expect(
      inferLogical("a && b", [
        { name: "a", type: F64 },
        { name: "b", type: F64 },
      ]),
    ).toEqual(F64);
    expect(
      inferLogical("a || b", [
        { name: "a", type: F64 },
        { name: "b", type: F64 },
      ]),
    ).toEqual(F64);
  });

  it("never claims BOOL for a mixed bool/non-bool pair", () => {
    // f64 && bool: the result is either an f64 or a bool — definitely not a
    // guaranteed boolean. Must not be BOOL (it joins to a union here).
    const r = inferLogical("a && b", [
      { name: "a", type: F64 },
      { name: "b", type: BOOL },
    ]);
    expect(r).not.toEqual(BOOL);
  });
});
