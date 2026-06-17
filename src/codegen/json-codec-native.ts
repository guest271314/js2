// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm dynamic JSON codec for standalone / WASI targets — #1599 Phase 2
 * (issue #2166, PR-A).
 *
 * `json-standalone.ts` folds *statically known* JSON literal graphs at compile
 * time, and `json-runtime.ts` adds the lone-runtime-primitive serialisers
 * (`__json_quote_string`, `__json_parse_primitive`). What was still missing —
 * and the bulk of the standalone JSON conformance residual — is
 * `JSON.stringify` of a **dynamic object graph**: a runtime-built object/array
 * whose contents are not known at compile time (`const o = {}; o.x = f();
 * JSON.stringify(o)`). Before this module that case either refused (#1599
 * Phase-1) or, worse, silently folded the *empty* declaration literal and
 * dropped the runtime mutations (returning `"{}"`).
 *
 * This module emits a recursive pure-Wasm `SerializeJSONProperty`
 * (`__json_stringify_value`) over the value representation the standalone
 * object runtime already uses — it is a traversal + formatter, NOT new
 * representation work:
 *
 *   - `$Object`  (object-runtime.ts) — own enumerable string-keyed props in
 *     insertion order via the existing `__obj_ordered` helper.
 *   - `$ObjVec`  — the externref vector backing array enumeration results.
 *   - `$AnyString` (native string) — quoted with the existing
 *     `__json_quote_string`.
 *   - `$__box_number_struct` / `$__box_boolean_struct` — the standalone boxed
 *     primitives, plus the `$AnyValue` tagged union (from the parse path).
 *
 * Spec: ECMA-262 §25.5.2 SerializeJSONProperty / SerializeJSONObject /
 * SerializeJSONArray (ECMA-404 grammar). PR-A is compact output only;
 * indentation (`space`) is PR-B, and `JSON.parse` of graphs is PR-C.
 *
 * Edge cases handled here (§25.5.2):
 *   - a `null` reference / `$AnyValue` tag 0 → the JSON `null` literal.
 *   - `NaN` / `±Infinity` → `null`; `-0` → `0`; otherwise Number::toString.
 *   - a value whose serialisation is *undefined* (function / symbol / an
 *     unsupported ref) returns a null `$AnyString` from the recursion — the
 *     array arm emits `null` for it, the object arm omits the property.
 *   - circular references: bounded by a recursion-depth cap (returns the
 *     empty serialisation on overflow rather than trapping). A proper
 *     TypeError-throwing seen-set is a follow-up (noted in the issue file).
 */
import type { Instr, ValType } from "../ir/types.js";
import { ensureAnyValueType } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers, nativeStringLiteralInstrs, nativeStringType } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { addFuncType } from "./registry/types.js";
import { emitJsonQuoteString } from "./json-runtime.js";

const EQ_HEAP_TYPE = -19; // signed LEB128 → 0x6d → TYPE.eq (for ref.null any/eq)

/** Maximum nesting depth before the codec bails (circular-ref guard). */
const MAX_JSON_DEPTH = 512;

/**
 * Emit `__json_stringify_value(v: anyref, depth: i32) -> ref null $AnyString`
 * and register it in `ctx.funcMap`. Idempotent. Standalone / WASI only.
 *
 * A null result encodes "value serialises to JS `undefined`" (function /
 * symbol / unsupported ref) — the caller's array/object arms apply the §25.5.2
 * omit-vs-`null` rule.
 *
 * Returns the funcIdx.
 */
export function emitJsonStringifyValue(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_stringify_value");
  if (existing !== undefined) return existing;

  // Dependencies. All idempotent.
  ensureNativeStringHelpers(ctx);
  ensureAnyValueType(ctx);
  const objTypes = ensureObjectRuntime(ctx);
  emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  const quoteIdx = emitJsonQuoteString(ctx);

  const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
  const orderedIdx = ctx.funcMap.get("__obj_ordered")!;
  const numToStrIdx = ctx.funcMap.get("number_toString");

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const anyValueTypeIdx = ctx.anyValueTypeIdx;
  const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
  const boxBoolTypeIdx = ctx.nativeBoxBooleanTypeIdx;
  const objectTypeIdx = objTypes.objectTypeIdx;
  const propMapTypeIdx = objTypes.propMapTypeIdx;
  const propEntryTypeIdx = objTypes.propEntryTypeIdx;
  const objVecTypeIdx = objTypes.objVecTypeIdx;
  const objVecArrTypeIdx = objTypes.objVecArrTypeIdx;

  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const anyref: ValType = { kind: "anyref" };
  const strRefNull: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  const strRef = nativeStringType(ctx); // ref $AnyString

  // Pre-register the self funcIdx so the recursive calls in the body resolve.
  const typeIdx = addFuncType(ctx, [anyref, i32], [strRefNull]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__json_stringify_value", funcIdx);

  // ── Local plan ──────────────────────────────────────────────────────────
  // params: 0 v:anyref  1 depth:i32
  const P_V = 0;
  const P_DEPTH = 1;
  const L_ANY = 2; // anyref scratch (re-tested value)
  const L_OBJ = 3; // ref null $Object
  const L_ARR = 4; // ref null $PropMap (ordered) / loop reuse
  const L_VEC = 5; // ref null $ObjVec
  const L_CAP = 6; // i32 loop bound
  const L_I = 7; // i32 loop index
  const L_E = 8; // ref null $PropEntry
  const L_OUT = 9; // ref $AnyString accumulator
  const L_PIECE = 10; // ref null $AnyString per-element/prop serialisation
  const L_FIRST = 11; // i32 — first-emitted flag (comma control)
  const L_NUM = 12; // f64 number scratch
  const L_DATA = 13; // ref $ObjVecArr (vec backing)

  const litStr = (s: string): Instr[] => nativeStringLiteralInstrs(ctx, s);

  // out = __str_concat(out, <piece in L_PIECE, non-null>)
  const appendPiece: Instr[] = [
    { op: "local.get", index: L_OUT },
    { op: "ref.as_non_null" },
    { op: "local.get", index: L_PIECE },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: concatIdx },
    { op: "local.set", index: L_OUT },
  ];

  // out = __str_concat(out, <literal>)
  const appendLit = (s: string): Instr[] => [
    { op: "local.get", index: L_OUT },
    { op: "ref.as_non_null" },
    ...litStr(s),
    { op: "call", funcIdx: concatIdx },
    { op: "local.set", index: L_OUT },
  ];

  // ── number arm: format f64 (in L_NUM) per JSON rules → push ref $AnyString ─
  // NaN / +-Inf → "null"; everything else via number_toString (which already
  // renders -0 as "0" and integers without a trailing ".0").
  const formatNumber: Instr[] = numToStrIdx === undefined
    ? [...litStr("null")] // no formatter available → degrade to null
    : [
        // if (n != n) → "null"   (NaN)
        { op: "local.get", index: L_NUM },
        { op: "local.get", index: L_NUM },
        { op: "f64.ne" },
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: [...litStr("null")],
          else: [
            // if (abs(n) == +Inf) → "null"
            { op: "local.get", index: L_NUM },
            { op: "f64.abs" },
            { op: "f64.const", value: Infinity },
            { op: "f64.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: strRef },
              then: [...litStr("null")],
              else: [
                { op: "local.get", index: L_NUM },
                { op: "call", funcIdx: numToStrIdx },
                // number_toString returns externref ($NativeString widened) →
                // bring back to a ref $AnyString for concat.
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: anyStrTypeIdx },
              ],
            },
          ],
        },
      ];

  // ── $AnyValue arm: discriminate by tag, leave a ref $AnyString on stack ────
  // tag 0/1 → "null" (undefined-as-value at this depth already became null);
  // tag 2 i32 number; tag 3 f64 number; tag 4 bool; tag 5 string; else "null".
  const anyValueArm: Instr[] = [
    // tag = av.tag
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: anyValueTypeIdx },
    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
    // switch on tag using a chain of if/else (small, fixed set)
    { op: "local.set", index: L_I }, // reuse L_I as tag holder
    // tag == 4 (bool)?
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 4 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        // av.i32val ? "true" : "false"
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: anyValueTypeIdx },
        { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 1 },
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: [...litStr("true")],
          else: [...litStr("false")],
        },
      ],
      else: [
        // tag == 5 (string)?
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 5 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: [
            // __json_quote_string(av.externval)
            { op: "local.get", index: L_ANY },
            { op: "ref.cast", typeIdx: anyValueTypeIdx },
            { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 4 },
            { op: "call", funcIdx: quoteIdx },
          ],
          else: [
            // tag 2 (i32) or 3 (f64) → number
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 2 },
            { op: "i32.eq" },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 3 },
            { op: "i32.eq" },
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "val", type: strRef },
              then: [
                // n = (tag==2) ? f64(i32val) : f64val
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 2 },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "val", type: f64 },
                  then: [
                    { op: "local.get", index: L_ANY },
                    { op: "ref.cast", typeIdx: anyValueTypeIdx },
                    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 1 },
                    { op: "f64.convert_i32_s" },
                  ],
                  else: [
                    { op: "local.get", index: L_ANY },
                    { op: "ref.cast", typeIdx: anyValueTypeIdx },
                    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 2 },
                  ],
                },
                { op: "local.set", index: L_NUM },
                ...formatNumber,
              ],
              else: [...litStr("null")], // tag 0/1/6 → null
            },
          ],
        },
      ],
    },
  ];

  // ── array arm ($ObjVec): "[" elem0 "," elem1 ... "]" ─────────────────────
  // A null/undefined/function element serialises as "null" inside an array.
  const arrayArm: Instr[] = [
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: objVecTypeIdx },
    { op: "local.set", index: L_VEC },
    { op: "local.get", index: L_VEC },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 }, // data
    { op: "local.set", index: L_DATA },
    { op: "local.get", index: L_VEC },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 }, // len
    { op: "local.set", index: L_CAP },
    // out = "["
    ...litStr("["),
    { op: "local.set", index: L_OUT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_CAP },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // comma before every element after the first
            { op: "local.get", index: L_I },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...appendLit(",")],
            },
            // piece = __json_stringify_value(any.convert_extern(data[i]), depth+1)
            { op: "local.get", index: L_DATA },
            { op: "local.get", index: L_I },
            { op: "array.get", typeIdx: objVecArrTypeIdx },
            { op: "any.convert_extern" },
            { op: "local.get", index: P_DEPTH },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "call", funcIdx },
            { op: "local.set", index: L_PIECE },
            // null piece (undefined element) → "null"
            { op: "local.get", index: L_PIECE },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...appendLit("null")],
              else: [...appendPiece],
            },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    ...appendLit("]"),
    { op: "local.get", index: L_OUT },
    { op: "return" },
  ];

  // ── object arm ($Object): "{" key0 ":" val0 "," ... "}" ──────────────────
  // Own enumerable string keys in insertion order via __obj_ordered. A property
  // whose value serialises to undefined (null piece) is omitted (§25.5.2).
  const objectArm: Instr[] = [
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: L_OBJ },
    { op: "local.get", index: L_OBJ },
    { op: "call", funcIdx: orderedIdx },
    { op: "local.set", index: L_ARR },
    { op: "local.get", index: L_ARR },
    { op: "array.len" },
    { op: "local.set", index: L_CAP },
    ...litStr("{"),
    { op: "local.set", index: L_OUT },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L_FIRST }, // 1 = no element emitted yet
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_CAP },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // e = arr[i]; ordered array is compacted — stop at first null
            { op: "local.get", index: L_ARR },
            { op: "local.get", index: L_I },
            { op: "array.get", typeIdx: propMapTypeIdx },
            { op: "local.tee", index: L_E },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            // piece = __json_stringify_value(e.value, depth+1)
            { op: "local.get", index: L_E },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value:anyref
            { op: "local.get", index: P_DEPTH },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "call", funcIdx },
            { op: "local.set", index: L_PIECE },
            // omit the property entirely if its value serialised to undefined
            { op: "local.get", index: L_PIECE },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // comma if not the first emitted property
                { op: "local.get", index: L_FIRST },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [...appendLit(",")],
                },
                { op: "i32.const", value: 0 },
                { op: "local.set", index: L_FIRST },
                // quote(key) : piece
                { op: "local.get", index: L_OUT },
                { op: "ref.as_non_null" },
                { op: "local.get", index: L_E },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 }, // key:ref $AnyString
                { op: "extern.convert_any" },
                { op: "call", funcIdx: quoteIdx },
                { op: "call", funcIdx: concatIdx },
                { op: "local.set", index: L_OUT },
                ...appendLit(":"),
                ...appendPiece,
              ],
            },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    ...appendLit("}"),
    { op: "local.get", index: L_OUT },
    { op: "return" },
  ];

  // ── dispatch ──────────────────────────────────────────────────────────────
  const body: Instr[] = [
    // depth guard (circular-ref bound): return null on overflow.
    { op: "local.get", index: P_DEPTH },
    { op: "i32.const", value: MAX_JSON_DEPTH },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null", typeIdx: anyStrTypeIdx }, { op: "return" }],
    },
    // null ref → JSON "null"
    { op: "local.get", index: P_V },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...litStr("null"), { op: "return" }],
    },
    // any = v
    { op: "local.get", index: P_V },
    { op: "local.set", index: L_ANY },
    // $Object?
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: objectArm,
    },
    // $ObjVec?
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: arrayArm,
    },
    // $AnyString (native string)?
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: quoteIdx },
        { op: "return" },
      ],
    },
    // $__box_number_struct?
    ...(boxNumTypeIdx >= 0
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: boxNumTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: L_ANY },
              { op: "ref.cast", typeIdx: boxNumTypeIdx },
              { op: "struct.get", typeIdx: boxNumTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: L_NUM },
              ...formatNumber,
              { op: "return" },
            ],
          },
        ] as Instr[])
      : []),
    // $__box_boolean_struct?
    ...(boxBoolTypeIdx >= 0
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: boxBoolTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: L_ANY },
              { op: "ref.cast", typeIdx: boxBoolTypeIdx },
              { op: "struct.get", typeIdx: boxBoolTypeIdx, fieldIdx: 0 },
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: [...litStr("true")],
                else: [...litStr("false")],
              },
              { op: "return" },
            ],
          },
        ] as Instr[])
      : []),
    // $AnyValue (the parse-path tagged union)?
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: anyValueTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...anyValueArm, { op: "return" }],
    },
    // unsupported ref → serialises to undefined → null result (omit/null at caller)
    { op: "ref.null", typeIdx: anyStrTypeIdx },
  ];

  ctx.mod.functions.push({
    name: "__json_stringify_value",
    typeIdx,
    locals: [
      { count: 1, type: anyref }, // L_ANY
      { count: 1, type: { kind: "ref_null", typeIdx: objectTypeIdx } }, // L_OBJ
      { count: 1, type: { kind: "ref_null", typeIdx: propMapTypeIdx } }, // L_ARR
      { count: 1, type: { kind: "ref_null", typeIdx: objVecTypeIdx } }, // L_VEC
      { count: 1, type: i32 }, // L_CAP
      { count: 1, type: i32 }, // L_I
      { count: 1, type: { kind: "ref_null", typeIdx: propEntryTypeIdx } }, // L_E
      { count: 1, type: strRefNull }, // L_OUT (nullable; set before every read)
      { count: 1, type: strRefNull }, // L_PIECE
      { count: 1, type: i32 }, // L_FIRST
      { count: 1, type: f64 }, // L_NUM
      { count: 1, type: { kind: "ref", typeIdx: objVecArrTypeIdx } }, // L_DATA
    ],
    body,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  // ── __json_stringify_root(v: anyref) -> ref $AnyString ────────────────────
  // The call-site entry: serialise at depth 0 and coalesce a null result (a
  // top-level value that serialises to JS `undefined` — function/symbol/an
  // unsupported ref) to the literal "null". Top-level `undefined` strictly
  // returns JS `undefined`, not "null"; object/array arguments (the routed
  // case) never serialise to undefined, so this only affects the rare
  // top-level-undefined edge — documented PR-A limitation. Returns a non-null
  // ref $AnyString so the call site sees the same type the primitive
  // string-stringify path returns.
  const rootTypeIdx = addFuncType(ctx, [anyref], [strRef]);
  const rootFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__json_stringify_root", rootFuncIdx);
  ctx.mod.functions.push({
    name: "__json_stringify_root",
    typeIdx: rootTypeIdx,
    locals: [{ count: 1, type: strRefNull }],
    body: [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx },
      { op: "local.tee", index: 1 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [...litStr("null")],
        else: [{ op: "local.get", index: 1 }, { op: "ref.as_non_null" }],
      },
    ],
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  return funcIdx;
}
