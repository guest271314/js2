// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3171) Shared receiver brand-check preamble for reflectively-invoked builtin
 * prototype methods — the spec's step-1/2 "If `this` does not have a [[X]]
 * internal slot, throw a TypeError" gate, generalized from the #2604
 * `emitSetBrandCheck` so every brand-carrying builtin family parameterizes ONE
 * helper instead of hand-rolling copies:
 *
 *   - Map/Set/WeakMap/WeakSet (#3171): struct brand `$Map` + the
 *     `COLLECTION_KIND` tag field ([[MapData]] vs [[SetData]] vs
 *     [[WeakMapData]] vs [[WeakSetData]] — the four share the `$Map` backing
 *     store, so struct identity alone cannot separate them).
 *   - Set-algebra argument validation (#2607/#3172): struct brand `$Map`,
 *     kind-lenient (a Map IS spec "set-like" — it has size/has/keys).
 *   - Date (#3174): struct brand only (`$Date` has no sharing to disambiguate).
 *
 * Precedent: the #2893 `$__ta_dyn_view` TypedArray view-brand check — a
 * NON-TRAPPING `ref.test` (never `ref.cast`: a cast miss traps `illegal cast`,
 * which `assert.throws(TypeError, …)` does NOT accept) branching to a
 * *catchable* TypeError instance on the miss arm.
 *
 * Contract: consumes the just-compiled receiver value on the stack (`recvType`
 * describes it) and leaves a non-null `(ref spec.structTypeIdx)` — the
 * validated backing struct — on the stack. On a brand miss the emitted code
 * throws before reaching the downstream helper call; an unreachable null
 * sentinel keeps the stack well-typed.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError } from "./expressions/helpers.js";

/** WasmGC `none` bottom heap type (signed LEB -18); `ref.null none` is the
 *  canonical null anyref subtype (mirrors map-runtime's NONE_HEAP). */
const NONE_HEAP = -18;

/** What a receiver must be to pass the brand gate. */
export type ReceiverBrandSpec = {
  /** TypeError message on a brand miss (test262 only checks the constructor,
   *  but a stable V8-style message keeps failure signatures greppable). */
  message: string;
  /** The WasmGC struct type the receiver must be (`ref.test` target). */
  structTypeIdx: number;
  /**
   * Optional refinement for struct types SHARED by several builtin brands
   * (e.g. `$Map` backs all four keyed collections): an immutable i32 tag
   * field that must hold one of `accept`. Omit for a struct-only check.
   */
  kindField?: { fieldIdx: number; accept: readonly number[] };
};

/**
 * Emit the brand-check preamble. Consumes the receiver value on the stack
 * (described by `recvType`; `null` = statically void/absent) and leaves a
 * non-null `(ref spec.structTypeIdx)` on the stack; a runtime brand miss
 * throws a catchable TypeError instead.
 */
export function emitReceiverBrandCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvType: ValType | null,
  spec: ReceiverBrandSpec,
): void {
  // Normalise the receiver to an anyref so `ref.test`/`ref.cast` apply
  // uniformly across externref / ref-struct / primitive-typed receivers.
  if (recvType === null) {
    // Statically void/never receiver — a null anyref misses the test below.
    fctx.body.push({ op: "ref.null", typeIdx: NONE_HEAP });
  } else if (recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (
    recvType.kind === "i32" ||
    recvType.kind === "f64" ||
    recvType.kind === "i64" ||
    recvType.kind === "funcref"
  ) {
    // A primitive scalar (or bare funcref) receiver can never be the backing
    // struct — drop it and throw unconditionally.
    fctx.body.push({ op: "drop" });
    emitReceiverBrandThrow(ctx, fctx, spec);
    return;
  }
  // Receiver is now an anyref (or a ref/eqref subtype) on the stack.
  const recvTmp = allocTempLocal(fctx, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.tee", index: recvTmp });
  fctx.body.push({ op: "ref.test", typeIdx: spec.structTypeIdx });

  // Optional kind-tag refinement: pass = structTest && (kind ∈ accept).
  const kindField = spec.kindField;
  if (kindField !== undefined && kindField.accept.length > 0) {
    const readKind: Instr[] = [
      { op: "local.get", index: recvTmp },
      { op: "ref.cast", typeIdx: spec.structTypeIdx }, // safe: struct test passed
      { op: "struct.get", typeIdx: spec.structTypeIdx, fieldIdx: kindField.fieldIdx },
    ];
    let acceptTest: Instr[];
    if (kindField.accept.length === 1) {
      acceptTest = [...readKind, { op: "i32.const", value: kindField.accept[0]! }, { op: "i32.eq" }];
    } else {
      const kindTmp = allocTempLocal(fctx, { kind: "i32" } as ValType);
      acceptTest = [...readKind, { op: "local.set", index: kindTmp }];
      kindField.accept.forEach((k, i) => {
        acceptTest.push({ op: "local.get", index: kindTmp });
        acceptTest.push({ op: "i32.const", value: k });
        acceptTest.push({ op: "i32.eq" });
        if (i > 0) acceptTest.push({ op: "i32.or" });
      });
      releaseTempLocal(fctx, kindTmp);
    }
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: acceptTest,
      else: [{ op: "i32.const", value: 0 }],
    });
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: [],
  });
  // Build the throw into the else arm via a temporary body swap so the
  // late-import shift in emitThrowTypeError patches the right buffer (#2604).
  const ifInstr = fctx.body[fctx.body.length - 1] as unknown as { else: Instr[] };
  const savedBody = fctx.body;
  fctx.body = ifInstr.else;
  emitThrowTypeError(ctx, fctx, spec.message);
  fctx.body = savedBody;
  // Hit: cast the saved receiver to the concrete backing struct.
  fctx.body.push({ op: "local.get", index: recvTmp });
  fctx.body.push({ op: "ref.cast", typeIdx: spec.structTypeIdx });
  releaseTempLocal(fctx, recvTmp);
}

/**
 * Emit an UNCONDITIONAL brand-miss throw (receiver statically absent — e.g.
 * `X.prototype.m.call()` with no argument, `this` = undefined — or statically
 * a scalar). Leaves an (unreachable) null `(ref_null spec.structTypeIdx)`
 * sentinel on the stack so the downstream call still typechecks; callers that
 * need a NON-null ref must `ref.as_non_null`… in practice the sentinel feeds a
 * helper param typed `(ref $T)`, so we cast it non-null via `ref.as_non_null`
 * here — the instruction is never reached.
 */
export function emitReceiverBrandThrow(ctx: CodegenContext, fctx: FunctionContext, spec: ReceiverBrandSpec): void {
  emitThrowTypeError(ctx, fctx, spec.message);
  fctx.body.push({ op: "ref.null", typeIdx: spec.structTypeIdx });
  fctx.body.push({ op: "ref.as_non_null" });
}
