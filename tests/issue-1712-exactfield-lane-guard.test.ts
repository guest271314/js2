// (#1712) Regression guard for PR #3267's 479f747c exact-struct-field read lane
// (property-access-dispatch.ts, `finalizeStructAndDynamicMemberGet`).
//
// The lane reads `recv.prop` directly from a compiled struct field when the
// receiver's typeName is unrecoverable but its checker type resolves to an
// exact struct typeIdx with a same-named field. Unrestricted, it also hijacked
// receivers whose RUNTIME representation is a growable host `$Object` (the anon
// struct exists but is never instantiated — acorn's `types$1` token table and
// `prototypeAccessors` descriptor tables, both marked growable by their depth-2
// writes). For a ref_null-typed field the `emitExternrefToStructGet`
// __extern_get fallback ref.tests the HOST result against the struct type,
// fails, and substitutes ref.null — so `prototypeAccessors.<k>.get = fn` wrote
// onto null, `Object.defineProperties(Parser.prototype, …)` installed
// getterless accessors, and every acorn scope predicate (inFunction /
// inGenerator / allowNewDotTarget) answered undefined→false: genuine
// "'return' outside of function" / new.target / yield SyntaxErrors
// (acorn-probe 13/13 → 8/13, acorn-corpus 23/23 → 13/23).
//
// The fix restricts the lane to defineProperty-WIDENED structs
// (`widenedVarStructMap` + `widenedDefinePropertyKeys`), whose runtime value IS
// the struct. These tests pin both sides:
//   - the descriptor-table shape must read back the live host value (42), and
//   - the widened defineProperty data read the lane was built for (#3367) must
//     keep returning its struct-stored value (2010).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// acorn's prototypeAccessors shape: descriptor table with depth-2 writes
// (growable → runtime host $Object), accessors installed from it. On the
// regressed compiler the base read `protoAcc.flagB` returned ref.null, the
// .get write was dropped, and probeAccessor() returned undefined/null.
const PROTO_ACCESSOR_TABLE_SRC = `
var protoAcc = { flagA: { configurable: true }, flagB: { configurable: true } };
protoAcc.flagA.get = function () { return 41; };
protoAcc.flagB.get = function () { return 42; };
var P = function P() {};
Object.defineProperties(P.prototype, protoAcc);
export function probeAccessor() {
  var p = new P();
  return p.flagB;
}
`;

// acorn's types$1 shape: token table holding constructed instances, marked
// growable by depth-2 updateContext writes; token identity must hold across
// the tokenizer-assignment lane and the direct table-read lane.
const TOKEN_TABLE_SRC = `
var TokenType = function TokenType(label) {
  this.label = label;
};
var types = { a: new TokenType("a"), b: new TokenType("b") };
types.a.updateContext = types.b.updateContext = function () { return 0; };
var Parser = function Parser() {
  this.type = types.a;
};
Parser.prototype.check = function () {
  return this.type === types.a ? 1 : 0;
};
export function probeIdentity() {
  var p = new Parser();
  return p.check();
}
export function probeLabel() {
  var p = new Parser();
  return types.b.label;
}
`;

// The positive case the lane was added for (#3367): a widened
// Object.defineProperty data value on a module-global \`var obj = {}\` lives in
// the widened struct field; the sidecar's value bit is deliberately absent, so
// ONLY the exact-field lane serves this read.
const WIDENED_DEFINE_PROPERTY_SRC = `
var obj = {};
Object.defineProperty(obj, "prop", { value: 2010, writable: false });
export function probeWidened() {
  return obj.prop;
}
`;

async function compileAndRun(source: string, fn: string): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#1712 exact-struct-field read lane guard (PR #3267 479f747c regression)", () => {
  it("descriptor-table base read returns the live host descriptor, not ref.null", async () => {
    expect(await compileAndRun(PROTO_ACCESSOR_TABLE_SRC, "probeAccessor")).toBe(42);
  });

  it("token-table identity holds across assignment and direct-read lanes", async () => {
    expect(await compileAndRun(TOKEN_TABLE_SRC, "probeIdentity")).toBe(1);
  });

  it("token-table instance field reads stay live", async () => {
    expect(await compileAndRun(TOKEN_TABLE_SRC, "probeLabel")).toBe("b");
  });

  it("widened defineProperty data read keeps its struct-stored value (#3367)", async () => {
    expect(await compileAndRun(WIDENED_DEFINE_PROPERTY_SRC, "probeWidened")).toBe(2010);
  });
});
