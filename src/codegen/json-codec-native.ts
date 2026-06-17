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
import {
  ensureNativeStringHelpers,
  nativeStringLiteralInstrs,
  nativeStringType,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { addFuncType } from "./registry/types.js";
import { emitJsonQuoteString } from "./json-runtime.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { reserveReviverDriver } from "./accessor-driver.js";

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

  const repeatIdx = ctx.nativeStrHelpers.get("__str_repeat")!; // (#2166 PR-B) indent builder

  // Pre-register the self funcIdx so the recursive calls in the body resolve.
  // (#2166 PR-B) `gap` (param 2, `ref null $AnyString`) is the per-level indent
  // unit (e.g. "  "). A null gap selects the compact form (PR-A behaviour, zero
  // overhead); a non-null gap drives §25.5.2 pretty-printing.
  const typeIdx = addFuncType(ctx, [anyref, i32, strRefNull], [strRefNull]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__json_stringify_value", funcIdx);

  // ── Local plan ──────────────────────────────────────────────────────────
  // params: 0 v:anyref  1 depth:i32  2 gap:ref null $AnyString
  const P_V = 0;
  const P_DEPTH = 1;
  const P_GAP = 2;
  const L_ANY = 3; // anyref scratch (re-tested value)
  const L_OBJ = 4; // ref null $Object
  const L_ARR = 5; // ref null $PropMap (ordered) / loop reuse
  const L_VEC = 6; // ref null $ObjVec
  const L_CAP = 7; // i32 loop bound
  const L_I = 8; // i32 loop index
  const L_E = 9; // ref null $PropEntry
  const L_OUT = 10; // ref $AnyString accumulator
  const L_PIECE = 11; // ref null $AnyString per-element/prop serialisation
  const L_FIRST = 12; // i32 — first-emitted flag (comma control)
  const L_NUM = 13; // f64 number scratch
  const L_DATA = 14; // ref $ObjVecArr (vec backing)
  // (#2166 PR-B) Precomputed separator strings (empty when gap is null):
  const L_NL_IN = 15; // ref $AnyString — "\n" + indent at the *inner* (depth+1) level
  const L_NL_OUT = 16; // ref $AnyString — "\n" + indent at *this* depth (before close)
  const L_COLON = 17; // ref $AnyString — ": " when indented, ":" when compact

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

  // (#2166 PR-B) out = __str_concat(out, <separator local — always non-null>)
  // Used for the precomputed newline/indent separators (L_NL_IN/L_NL_OUT/
  // L_COLON). They are the empty string when gap is null, so concatenating
  // them in the compact form is a no-op (and `__str_concat` short-circuits an
  // empty argument).
  const appendSep = (sepLocal: number): Instr[] => [
    { op: "local.get", index: L_OUT },
    { op: "ref.as_non_null" },
    { op: "local.get", index: sepLocal },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: concatIdx },
    { op: "local.set", index: L_OUT },
  ];

  // (#2166 PR-B) Compute the per-call separator strings into L_NL_IN /
  // L_NL_OUT / L_COLON. With a null gap every separator is "" (and the colon is
  // ":"), so the loop bodies below emit byte-identical compact output. With a
  // non-null gap: L_NL_IN = "\n" + repeat(gap, depth+1); L_NL_OUT = "\n" +
  // repeat(gap, depth); L_COLON = ": ". `__str_repeat` returns "" for count 0,
  // so the top-level (depth 0) close indent is just "\n" as §25.5.2 requires.
  const setupSeparators: Instr[] = [
    { op: "local.get", index: P_GAP },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...litStr(""),
        { op: "local.set", index: L_NL_IN },
        ...litStr(""),
        { op: "local.set", index: L_NL_OUT },
        ...litStr(":"),
        { op: "local.set", index: L_COLON },
      ],
      else: [
        // L_NL_IN = "\n" + repeat(gap, depth + 1)
        ...litStr("\n"),
        { op: "local.get", index: P_GAP },
        { op: "ref.as_non_null" },
        { op: "local.get", index: P_DEPTH },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "call", funcIdx: repeatIdx },
        { op: "call", funcIdx: concatIdx },
        { op: "local.set", index: L_NL_IN },
        // L_NL_OUT = "\n" + repeat(gap, depth)
        ...litStr("\n"),
        { op: "local.get", index: P_GAP },
        { op: "ref.as_non_null" },
        { op: "local.get", index: P_DEPTH },
        { op: "call", funcIdx: repeatIdx },
        { op: "call", funcIdx: concatIdx },
        { op: "local.set", index: L_NL_OUT },
        // L_COLON = ": "
        ...litStr(": "),
        { op: "local.set", index: L_COLON },
      ],
    },
  ];

  // ── number arm: format f64 (in L_NUM) per JSON rules → push ref $AnyString ─
  // NaN / +-Inf → "null"; everything else via number_toString (which already
  // renders -0 as "0" and integers without a trailing ".0").
  const formatNumber: Instr[] =
    numToStrIdx === undefined
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
            // comma before every element after the first; then (#2166 PR-B) the
            // newline+indent separator (L_NL_IN, "" when compact) before each.
            { op: "local.get", index: L_I },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...appendLit(",")],
            },
            ...appendSep(L_NL_IN),
            // piece = __json_stringify_value(any.convert_extern(data[i]), depth+1, gap)
            { op: "local.get", index: L_DATA },
            { op: "local.get", index: L_I },
            { op: "array.get", typeIdx: objVecArrTypeIdx },
            { op: "any.convert_extern" },
            { op: "local.get", index: P_DEPTH },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: P_GAP },
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
    // (#2166 PR-B) closing-indent newline only for a non-empty array (§25.5.2:
    // an empty array stays "[]"). L_NL_OUT is "" when compact, so this is a
    // no-op there.
    { op: "local.get", index: L_CAP },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...appendSep(L_NL_OUT)],
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
            // piece = __json_stringify_value(e.value, depth+1, gap)
            { op: "local.get", index: L_E },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value:anyref
            { op: "local.get", index: P_DEPTH },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: P_GAP },
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
                // (#2166 PR-B) newline+indent before every property ("" compact)
                ...appendSep(L_NL_IN),
                // quote(key) <colon> piece — colon is ": " indented, ":" compact
                { op: "local.get", index: L_OUT },
                { op: "ref.as_non_null" },
                { op: "local.get", index: L_E },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 }, // key:ref $AnyString
                { op: "extern.convert_any" },
                { op: "call", funcIdx: quoteIdx },
                { op: "call", funcIdx: concatIdx },
                { op: "local.set", index: L_OUT },
                ...appendSep(L_COLON),
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
    // (#2166 PR-B) closing-indent newline only when at least one property was
    // emitted (L_FIRST == 0). An empty object stays "{}" (§25.5.2). L_NL_OUT is
    // "" when compact.
    { op: "local.get", index: L_FIRST },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...appendSep(L_NL_OUT)],
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
    // (#2166 PR-B) compute the indent separators for the object/array arms.
    // Only those arms read them; primitive arms below return before use.
    ...setupSeparators,
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
      { count: 1, type: strRef }, // L_NL_IN  (#2166 PR-B — always set in prologue)
      { count: 1, type: strRef }, // L_NL_OUT
      { count: 1, type: strRef }, // L_COLON
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
      // (#2166 PR-B) compact form: null gap.
      { op: "ref.null", typeIdx: anyStrTypeIdx },
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

  // ── __json_stringify_root_indent(v: anyref, gap: ref null $AnyString) ──────
  // (#2166 PR-B) The pretty-print entry: serialise at depth 0 with the caller's
  // indent unit (`gap`). A null/empty gap behaves like the compact root
  // (the worker's separators collapse to ""). Same null→"null" coalescing as
  // the compact root.
  const rootIndentTypeIdx = addFuncType(ctx, [anyref, strRefNull], [strRef]);
  const rootIndentFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__json_stringify_root_indent", rootIndentFuncIdx);
  ctx.mod.functions.push({
    name: "__json_stringify_root_indent",
    typeIdx: rootIndentTypeIdx,
    locals: [{ count: 1, type: strRefNull }],
    body: [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 }, // gap
      { op: "call", funcIdx },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [...litStr("null")],
        else: [{ op: "local.get", index: 2 }, { op: "ref.as_non_null" }],
      },
    ],
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  return funcIdx;
}

// ───────────────────────────────────────────────────────────────────────────
// PR-C: `JSON.parse` of a dynamic graph — `__json_parse_text`
// ───────────────────────────────────────────────────────────────────────────

/**
 * Emit the pure-Wasm recursive-descent `JSON.parse` codec (#2166 PR-C) and
 * register `__json_parse_text(s: externref) -> anyref` in `ctx.funcMap`.
 * Idempotent. Standalone / WASI only.
 *
 * The grammar is ECMA-404 / ECMA-262 §25.5.1 (strict JSON — no comments, no
 * trailing commas, no single quotes). The output uses the SAME value
 * representation the standalone object runtime and the `__json_stringify_value`
 * codec consume, so a round-trip `JSON.parse(JSON.stringify(o))` and downstream
 * property reads (`__extern_get`) work without conversion:
 *
 *   - object → a fresh `$Object` (built via `__new_plain_object` +
 *     `__extern_set`), widened to `anyref`. Members preserve insertion order.
 *   - array  → a fresh `$ObjVec` (built via `__objvec_new` + `__objvec_push`),
 *     widened to `anyref`.
 *   - string → a native `$AnyString` (the unescaped code units), widened to
 *     `anyref` — the same carrier object/array element reads already see.
 *   - number → boxed into the `$AnyValue` tagged union (tag 3, f64).
 *   - true / false → `$AnyValue` tag 4; null → `$AnyValue` tag 0.
 *
 * A grammar violation (or trailing non-whitespace) throws a runtime
 * `SyntaxError` via the standalone `__new_SyntaxError` constructor — matching
 * §25.5.1 step 3 — instead of trapping. The result `anyref` flows through the
 * existing `$AnyValue`/object coercion paths in type-coercion.ts.
 *
 * Implementation note: the mutually-recursive value/string parsers share a
 * cursor through a `$JsonP` parser-state struct (`{ data, pos(mut), end }`).
 * That struct is passed as a bare **`anyref`** parameter (and `ref.cast` back
 * inside each helper) rather than as `ref $JsonP`. A fresh GC struct type that
 * appears in a *function-signature* parameter has tripped the dead-type-
 * elimination remap in this codebase (the func-type param and the in-body
 * `struct.get` operand can diverge after compaction); keeping the fresh
 * `$JsonP` index off every signature and confined to `struct.new`/`struct.get`/
 * `struct.set`/`ref.cast` instruction operands — which `remapTypeIdxInBody`
 * rewrites uniformly — sidesteps that hazard.
 *
 * Returns the `__json_parse_text` funcIdx.
 */
export function emitJsonParseText(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_parse_text");
  if (existing !== undefined) return existing;

  // Dependencies (all idempotent).
  ensureNativeStringHelpers(ctx);
  ensureAnyValueType(ctx);
  ensureObjectRuntime(ctx);
  // The standalone SyntaxError constructor + the exception tag for the throw.
  emitWasiErrorConstructor(ctx, "SyntaxError", 1);

  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const newObjIdx = ctx.funcMap.get("__new_plain_object")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;

  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const anyref: ValType = { kind: "anyref" };
  const externref: ValType = { kind: "externref" };

  const strTypeIdx = ctx.nativeStrTypeIdx; // $NativeString { len, off, data }
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx; // (array (mut i16))
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  // Box parsed primitives into the SAME standalone boxed structs the object
  // runtime + `__unbox_number` understand (`$__box_number_struct {value:f64}`,
  // `$__box_boolean_struct {value:i32}`), NOT `$AnyValue`. A value stored into a
  // `$Object` via `__extern_set` is read back via the property path, whose
  // externref→number/boolean coercion only unboxes the `$__box_*` structs — an
  // `$AnyValue` would read back as NaN/undefined. (Top-level primitive parse
  // results unbox fine either way, but object/array members must use these.)
  const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
  const boxBoolTypeIdx = ctx.nativeBoxBooleanTypeIdx;
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const strRefNative: ValType = { kind: "ref", typeIdx: strTypeIdx };

  // ── $JsonP parser-state struct: { data: ref $strData, pos: (mut i32), end: i32 } ──
  // Confined to instruction operands only (never a function signature) — see the
  // doc-comment above for why.
  const jsonPTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$JsonP",
    // `$`-prefixed field names so `resolveSameShapeFieldNameCollisions` (which
    // skips `$`-prefixed fields) leaves this internal struct alone: a plain
    // `data`/`pos`/`end` triple collides with other structs' field names and
    // gets shape-canonicalised, which split the struct across two type indices
    // and desynced the in-body `struct.get` operand from the local's declared
    // type (`expected (ref 54), found (ref 72)`).
    fields: [
      { name: "$data", type: strDataRef, mutable: false },
      { name: "$pos", type: i32, mutable: true },
      { name: "$end", type: i32, mutable: false },
    ],
  } as unknown as (typeof ctx.mod.types)[number]);

  // ── throwSyntaxError(msg): build & throw a standalone SyntaxError ──────────
  // Mirrors emitThrowRegExpSyntaxError but as a body-level Instr[] (no fctx):
  // intern the message global, construct via __new_SyntaxError, throw via the
  // shared exception tag. A trailing `unreachable` makes the post-throw stack
  // polymorphic so the enclosing block's declared result type still validates.
  const tagIdx = ensureExnTag(ctx);
  const ctorIdx = ctx.funcMap.get("__new_SyntaxError")!;
  const throwSyntaxError = (msg: string): Instr[] => {
    addStringConstantGlobal(ctx, msg);
    return [
      ...stringConstantExternrefInstrs(ctx, msg),
      { op: "call", funcIdx: ctorIdx },
      { op: "throw", tagIdx } as Instr,
      { op: "unreachable" } as Instr,
    ];
  };

  // ════════════════════════════════════════════════════════════════════════
  // Pre-register the three recursive funcIdx values so the bodies can call
  // each other / themselves. All signatures use only primitive/anyref/externref
  // types — the fresh $JsonP index never reaches a func type.
  // ════════════════════════════════════════════════════════════════════════
  const valueTypeIdx = addFuncType(ctx, [anyref], [anyref]); // (p:anyref) -> value:anyref
  const valueFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__json_parse_value", valueFuncIdx);

  const strParseTypeIdx = addFuncType(ctx, [anyref], [strRefNative]); // (p:anyref) -> ref $NativeString
  const strParseFuncIdx = valueFuncIdx + 1;
  ctx.funcMap.set("__json_parse_str", strParseFuncIdx);

  const textTypeIdx = addFuncType(ctx, [externref], [anyref]);
  const textFuncIdx = valueFuncIdx + 2;
  ctx.funcMap.set("__json_parse_text", textFuncIdx);

  // ════════════════════════════════════════════════════════════════════════
  // __json_parse_value(p: anyref) -> anyref
  // ════════════════════════════════════════════════════════════════════════
  // params: 0 p:anyref
  const V_P = 0; // anyref (the $JsonP, re-cast on entry)
  const V_PS = 1; // ref $JsonP (cast result)
  const V_DATA = 2; // ref $strData
  const V_POS = 3; // i32 cursor
  const V_END = 4; // i32
  const V_C = 5; // i32 current code unit
  const V_OBJ = 6; // externref (object/array under construction)
  const V_KEY = 7; // ref $NativeString (object key)
  const V_VAL = 8; // anyref (recursive child)
  const V_NUM = 9; // f64
  const V_MANT = 10; // f64
  const V_SIGN = 11; // f64
  const V_EXP = 12; // i32
  const V_EXPSIGN = 13; // i32
  const V_EXPMAG = 14; // i32

  // p (anyref) → ref $JsonP in V_PS, done once at entry.
  const castP: Instr[] = [
    { op: "local.get", index: V_P },
    { op: "ref.cast", typeIdx: jsonPTypeIdx },
    { op: "local.set", index: V_PS },
  ];
  const loadPos: Instr[] = [
    { op: "local.get", index: V_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: V_POS },
  ];
  const storePos: Instr[] = [
    { op: "local.get", index: V_PS },
    { op: "local.get", index: V_POS },
    { op: "struct.set", typeIdx: jsonPTypeIdx, fieldIdx: 1 },
  ];
  const loadC: Instr[] = [
    { op: "local.get", index: V_DATA },
    { op: "local.get", index: V_POS },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: V_C },
  ];
  const cEqV = (code: number): Instr[] => [
    { op: "local.get", index: V_C },
    { op: "i32.const", value: code },
    { op: "i32.eq" },
  ];

  const skipWsV: Instr[] = [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: V_POS },
            { op: "local.get", index: V_END },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...loadC,
            ...cEqV(32),
            ...cEqV(9),
            { op: "i32.or" },
            ...cEqV(10),
            { op: "i32.or" },
            ...cEqV(13),
            { op: "i32.or" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];

  // Expect data[pos]==code then advance; mismatch/EOF → SyntaxError(msg).
  const expectChar = (code: number, msg: string): Instr[] => [
    { op: "local.get", index: V_POS },
    { op: "local.get", index: V_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError(msg) },
    ...loadC,
    ...cEqV(code),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError(msg) },
    { op: "local.get", index: V_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: V_POS },
  ];

  // Match a literal keyword (true/false/null) at pos; advance, else SyntaxError.
  const matchKeyword = (word: string): Instr[] => {
    const out: Instr[] = [];
    for (let k = 0; k < word.length; k++) {
      out.push(
        { op: "local.get", index: V_POS },
        { op: "local.get", index: V_END },
        { op: "i32.ge_s" },
        { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
        { op: "local.get", index: V_DATA },
        { op: "local.get", index: V_POS },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "i32.const", value: word.charCodeAt(k) },
        { op: "i32.ne" },
        { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected token in JSON") },
        { op: "local.get", index: V_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: V_POS },
      );
    }
    return out;
  };

  // Primitive box helpers (leave an `anyref` on the stack). Numbers/booleans use
  // the standalone boxed structs so object/array member reads unbox them; JSON
  // `null` becomes a null eqref (reads back as `null`, distinct from a missing
  // property which reads `undefined`).
  const boxNullAny: Instr[] = [{ op: "ref.null", typeIdx: EQ_HEAP_TYPE }];
  // JSON booleans box as a `$__box_number_struct` holding 1.0/0.0 — the SAME
  // representation `o.t = true` produces in a standalone object (TS `true` is an
  // i32 and the i32→externref store path boxes it as a number, #2166 PR-A note).
  // Matching it keeps member reads/round-trips consistent (`o.t ? …` works); a
  // distinct boolean identity (`o.t === true`) is the broader standalone
  // boolean-boxing gap (overlaps #1917), out of PR-C scope.
  void boxBoolTypeIdx;
  const boxBoolAny = (v: number): Instr[] => [
    { op: "f64.const", value: v },
    { op: "struct.new", typeIdx: boxNumTypeIdx },
  ];
  const boxF64AnyFromLocal = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "struct.new", typeIdx: boxNumTypeIdx },
  ];

  // number parser (cursor at '-'/digit) → f64 in V_NUM; advances V_POS.
  const parseNumberV: Instr[] = [
    { op: "f64.const", value: 1 },
    { op: "local.set", index: V_SIGN },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: V_MANT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: V_EXP },
    ...loadC,
    ...cEqV(45),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "f64.const", value: -1 },
        { op: "local.set", index: V_SIGN },
        { op: "local.get", index: V_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: V_POS },
      ],
    },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: V_POS },
            { op: "local.get", index: V_END },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...loadC,
            { op: "local.get", index: V_C },
            { op: "i32.const", value: 48 },
            { op: "i32.lt_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: V_C },
            { op: "i32.const", value: 57 },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: V_MANT },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.get", index: V_C },
            { op: "i32.const", value: 48 },
            { op: "i32.sub" },
            { op: "f64.convert_i32_s" },
            { op: "f64.add" },
            { op: "local.set", index: V_MANT },
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // fraction
    { op: "local.get", index: V_POS },
    { op: "local.get", index: V_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...loadC,
        ...cEqV(46),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: V_POS },
                    { op: "local.get", index: V_END },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    ...loadC,
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.lt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 57 },
                    { op: "i32.gt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: V_MANT },
                    { op: "f64.const", value: 10 },
                    { op: "f64.mul" },
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.sub" },
                    { op: "f64.convert_i32_s" },
                    { op: "f64.add" },
                    { op: "local.set", index: V_MANT },
                    { op: "local.get", index: V_EXP },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "local.set", index: V_EXP },
                    { op: "local.get", index: V_POS },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: V_POS },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    // exponent
    { op: "local.get", index: V_POS },
    { op: "local.get", index: V_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...loadC,
        ...cEqV(101),
        ...cEqV(69),
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: V_EXPSIGN },
            { op: "local.get", index: V_POS },
            { op: "local.get", index: V_END },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...loadC,
                ...cEqV(45),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: -1 },
                    { op: "local.set", index: V_EXPSIGN },
                    { op: "local.get", index: V_POS },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: V_POS },
                  ],
                  else: [
                    ...cEqV(43),
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: V_POS },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: V_POS },
                      ],
                    },
                  ],
                },
              ],
            },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: V_EXPMAG },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: V_POS },
                    { op: "local.get", index: V_END },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    ...loadC,
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.lt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 57 },
                    { op: "i32.gt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: V_EXPMAG },
                    { op: "i32.const", value: 10 },
                    { op: "i32.mul" },
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.sub" },
                    { op: "i32.add" },
                    { op: "local.set", index: V_EXPMAG },
                    { op: "local.get", index: V_POS },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: V_POS },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            { op: "local.get", index: V_EXP },
            { op: "local.get", index: V_EXPSIGN },
            { op: "local.get", index: V_EXPMAG },
            { op: "i32.mul" },
            { op: "i32.add" },
            { op: "local.set", index: V_EXP },
          ],
        },
      ],
    },
    // result = sign*mant*10^exp → V_NUM (reuse V_NUM as running pow)
    { op: "f64.const", value: 1 },
    { op: "local.set", index: V_NUM },
    { op: "local.get", index: V_EXP },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: V_EXP },
                { op: "i32.eqz" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: V_NUM },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.set", index: V_NUM },
                { op: "local.get", index: V_EXP },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "local.set", index: V_EXP },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
      else: [
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: V_EXP },
                { op: "i32.eqz" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: V_NUM },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "local.set", index: V_NUM },
                { op: "local.get", index: V_EXP },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: V_EXP },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    { op: "local.get", index: V_SIGN },
    { op: "local.get", index: V_MANT },
    { op: "f64.mul" },
    { op: "local.get", index: V_NUM },
    { op: "f64.mul" },
    { op: "local.set", index: V_NUM },
  ];

  const valueBody: Instr[] = [
    ...castP,
    { op: "local.get", index: V_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: V_DATA },
    ...loadPos,
    { op: "local.get", index: V_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: V_END },
    ...skipWsV,
    { op: "local.get", index: V_POS },
    { op: "local.get", index: V_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
    ...loadC,
    ...storePos,
    // '{' → object
    ...cEqV(123),
    {
      op: "if",
      blockType: { kind: "val", type: anyref },
      then: [
        { op: "local.get", index: V_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: V_POS },
        ...storePos,
        { op: "call", funcIdx: newObjIdx },
        { op: "local.set", index: V_OBJ },
        ...skipWsV,
        ...storePos,
        { op: "local.get", index: V_POS },
        { op: "local.get", index: V_END },
        { op: "i32.ge_s" },
        { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
        ...loadC,
        ...cEqV(125), // '}'
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            ...storePos,
          ],
          else: [
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    ...skipWsV,
                    ...storePos,
                    // key = __json_parse_str(p)
                    { op: "local.get", index: V_P },
                    { op: "call", funcIdx: strParseFuncIdx },
                    { op: "local.set", index: V_KEY },
                    ...loadPos,
                    ...skipWsV,
                    ...storePos,
                    ...expectChar(58, "Expected ':' after property name in JSON"),
                    ...storePos,
                    // val = __json_parse_value(p)
                    { op: "local.get", index: V_P },
                    { op: "call", funcIdx: valueFuncIdx },
                    { op: "local.set", index: V_VAL },
                    ...loadPos,
                    // __extern_set(obj, key(externref), val(externref))
                    { op: "local.get", index: V_OBJ },
                    { op: "local.get", index: V_KEY },
                    { op: "extern.convert_any" },
                    { op: "local.get", index: V_VAL },
                    { op: "extern.convert_any" },
                    { op: "call", funcIdx: externSetIdx },
                    ...skipWsV,
                    ...storePos,
                    { op: "local.get", index: V_POS },
                    { op: "local.get", index: V_END },
                    { op: "i32.ge_s" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: throwSyntaxError("Unexpected end of JSON input"),
                    },
                    ...loadC,
                    ...cEqV(44), // ','
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: V_POS },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: V_POS },
                        ...storePos,
                        { op: "br", depth: 1 }, // continue member loop
                      ],
                    },
                    ...cEqV(125), // '}'
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: V_POS },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: V_POS },
                        ...storePos,
                        { op: "br", depth: 2 }, // break member loop
                      ],
                    },
                    ...throwSyntaxError("Expected ',' or '}' after property value in JSON"),
                  ],
                },
              ],
            },
          ],
        },
        { op: "local.get", index: V_OBJ },
        { op: "any.convert_extern" },
      ],
      else: [
        // '[' → array
        ...cEqV(91),
        {
          op: "if",
          blockType: { kind: "val", type: anyref },
          then: [
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            ...storePos,
            { op: "call", funcIdx: objVecNewIdx },
            { op: "local.set", index: V_OBJ },
            ...skipWsV,
            ...storePos,
            { op: "local.get", index: V_POS },
            { op: "local.get", index: V_END },
            { op: "i32.ge_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: throwSyntaxError("Unexpected end of JSON input"),
            },
            ...loadC,
            ...cEqV(93), // ']'
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: V_POS },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: V_POS },
                ...storePos,
              ],
              else: [
                {
                  op: "block",
                  blockType: { kind: "empty" },
                  body: [
                    {
                      op: "loop",
                      blockType: { kind: "empty" },
                      body: [
                        ...storePos,
                        { op: "local.get", index: V_P },
                        { op: "call", funcIdx: valueFuncIdx },
                        { op: "local.set", index: V_VAL },
                        ...loadPos,
                        { op: "local.get", index: V_OBJ },
                        { op: "local.get", index: V_VAL },
                        { op: "extern.convert_any" },
                        { op: "call", funcIdx: objVecPushIdx },
                        ...skipWsV,
                        ...storePos,
                        { op: "local.get", index: V_POS },
                        { op: "local.get", index: V_END },
                        { op: "i32.ge_s" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: throwSyntaxError("Unexpected end of JSON input"),
                        },
                        ...loadC,
                        ...cEqV(44), // ','
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: V_POS },
                            { op: "i32.const", value: 1 },
                            { op: "i32.add" },
                            { op: "local.set", index: V_POS },
                            ...storePos,
                            { op: "br", depth: 1 }, // continue element loop
                          ],
                        },
                        ...cEqV(93), // ']'
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: V_POS },
                            { op: "i32.const", value: 1 },
                            { op: "i32.add" },
                            { op: "local.set", index: V_POS },
                            ...storePos,
                            { op: "br", depth: 2 }, // break element loop
                          ],
                        },
                        ...throwSyntaxError("Expected ',' or ']' after array element in JSON"),
                      ],
                    },
                  ],
                },
              ],
            },
            { op: "local.get", index: V_OBJ },
            { op: "any.convert_extern" },
          ],
          else: [
            // '"' → string value
            ...cEqV(34),
            {
              op: "if",
              blockType: { kind: "val", type: anyref },
              then: [
                { op: "local.get", index: V_P },
                { op: "call", funcIdx: strParseFuncIdx },
              ],
              else: [
                // 't' → true
                ...cEqV(116),
                {
                  op: "if",
                  blockType: { kind: "val", type: anyref },
                  then: [...matchKeyword("true"), ...storePos, ...boxBoolAny(1)],
                  else: [
                    // 'f' → false
                    ...cEqV(102),
                    {
                      op: "if",
                      blockType: { kind: "val", type: anyref },
                      then: [...matchKeyword("false"), ...storePos, ...boxBoolAny(0)],
                      else: [
                        // 'n' → null
                        ...cEqV(110),
                        {
                          op: "if",
                          blockType: { kind: "val", type: anyref },
                          then: [...matchKeyword("null"), ...storePos, ...boxNullAny],
                          else: [
                            // number: '-' or digit, else SyntaxError
                            ...cEqV(45),
                            { op: "local.get", index: V_C },
                            { op: "i32.const", value: 48 },
                            { op: "i32.ge_s" },
                            { op: "local.get", index: V_C },
                            { op: "i32.const", value: 57 },
                            { op: "i32.le_s" },
                            { op: "i32.and" },
                            { op: "i32.or" },
                            {
                              op: "if",
                              blockType: { kind: "val", type: anyref },
                              then: [...parseNumberV, ...storePos, ...boxF64AnyFromLocal(V_NUM)],
                              else: throwSyntaxError("Unexpected token in JSON"),
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  // ════════════════════════════════════════════════════════════════════════
  // __json_parse_str(p: anyref) -> ref $NativeString
  //   Cursor at opening '"'. Allocate a backing array sized to the raw span (an
  //   upper bound — escapes only shrink), fill the unescaped code units, then
  //   struct.new $NativeString(count, 0, data) with the real count (<= cap).
  // ════════════════════════════════════════════════════════════════════════
  const S_P = 0; // anyref
  const S_PS = 1; // ref $JsonP
  const S_DATA = 2; // ref $strData (input)
  const S_POS = 3; // i32
  const S_END = 4; // i32
  const S_START = 5; // i32 span start (after '"')
  const S_RAWEND = 6; // i32 closing '"' index
  const S_OUT = 7; // ref $strData (output buffer)
  const S_N = 8; // i32 output count
  const S_C = 9; // i32
  const S_HEX = 10; // i32 \uXXXX
  const S_K = 11; // i32 hex loop counter
  const S_SCAN = 12; // i32 first-pass scan cursor

  const sLoadC: Instr[] = [
    { op: "local.get", index: S_DATA },
    { op: "local.get", index: S_POS },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: S_C },
  ];
  const sAdvance: Instr[] = [
    { op: "local.get", index: S_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: S_POS },
  ];
  const sEmit = (valueInstrs: Instr[]): Instr[] => [
    { op: "local.get", index: S_OUT },
    { op: "local.get", index: S_N },
    ...valueInstrs,
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: S_N },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: S_N },
  ];
  const sHexDigit: Instr[] = [
    { op: "local.get", index: S_POS },
    { op: "local.get", index: S_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
    ...sLoadC,
    { op: "local.get", index: S_HEX },
    { op: "i32.const", value: 4 },
    { op: "i32.shl" },
    { op: "local.get", index: S_C },
    { op: "i32.const", value: 58 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [{ op: "local.get", index: S_C }, { op: "i32.const", value: 48 }, { op: "i32.sub" }],
      else: [
        { op: "local.get", index: S_C },
        { op: "i32.const", value: 97 },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [{ op: "local.get", index: S_C }, { op: "i32.const", value: 87 }, { op: "i32.sub" }],
          else: [{ op: "local.get", index: S_C }, { op: "i32.const", value: 55 }, { op: "i32.sub" }],
        },
      ],
    },
    { op: "i32.add" },
    { op: "local.set", index: S_HEX },
    ...sAdvance,
  ];

  const strParseBody: Instr[] = [
    { op: "local.get", index: S_P },
    { op: "ref.cast", typeIdx: jsonPTypeIdx },
    { op: "local.set", index: S_PS },
    { op: "local.get", index: S_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: S_DATA },
    { op: "local.get", index: S_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: S_POS },
    { op: "local.get", index: S_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: S_END },
    // opening '"'
    { op: "local.get", index: S_POS },
    { op: "local.get", index: S_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
    ...sLoadC,
    { op: "local.get", index: S_C },
    { op: "i32.const", value: 34 },
    { op: "i32.ne" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected token in JSON") },
    ...sAdvance,
    { op: "local.get", index: S_POS },
    { op: "local.set", index: S_START },
    // first pass: scan to closing quote
    { op: "local.get", index: S_POS },
    { op: "local.set", index: S_SCAN },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: S_SCAN },
            { op: "local.get", index: S_END },
            { op: "i32.ge_s" },
            { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unterminated string in JSON") },
            { op: "local.get", index: S_DATA },
            { op: "local.get", index: S_SCAN },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.set", index: S_C },
            { op: "local.get", index: S_C },
            { op: "i32.const", value: 34 },
            { op: "i32.eq" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: S_C },
            { op: "i32.const", value: 92 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: S_SCAN },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: S_SCAN },
              ],
            },
            { op: "local.get", index: S_SCAN },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: S_SCAN },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: S_SCAN },
    { op: "local.set", index: S_RAWEND },
    // buffer capacity = rawEnd - start
    { op: "local.get", index: S_RAWEND },
    { op: "local.get", index: S_START },
    { op: "i32.sub" },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: S_OUT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: S_N },
    // second pass: copy/unescape until rawEnd
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: S_POS },
            { op: "local.get", index: S_RAWEND },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...sLoadC,
            { op: "local.get", index: S_C },
            { op: "i32.const", value: 92 }, // '\'
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...sAdvance,
                { op: "local.get", index: S_POS },
                { op: "local.get", index: S_RAWEND },
                { op: "i32.ge_s" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: throwSyntaxError("Unterminated string in JSON"),
                },
                ...sLoadC,
                { op: "local.get", index: S_C },
                { op: "i32.const", value: 117 }, // 'u'
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    ...sAdvance,
                    { op: "i32.const", value: 0 },
                    { op: "local.set", index: S_HEX },
                    { op: "i32.const", value: 0 },
                    { op: "local.set", index: S_K },
                    {
                      op: "block",
                      blockType: { kind: "empty" },
                      body: [
                        {
                          op: "loop",
                          blockType: { kind: "empty" },
                          body: [
                            { op: "local.get", index: S_K },
                            { op: "i32.const", value: 4 },
                            { op: "i32.ge_s" },
                            { op: "br_if", depth: 1 },
                            ...sHexDigit,
                            { op: "local.get", index: S_K },
                            { op: "i32.const", value: 1 },
                            { op: "i32.add" },
                            { op: "local.set", index: S_K },
                            { op: "br", depth: 0 },
                          ],
                        },
                      ],
                    },
                    ...sEmit([{ op: "local.get", index: S_HEX }]),
                  ],
                  else: [
                    ...sEmit([
                      { op: "local.get", index: S_C },
                      { op: "i32.const", value: 98 }, // 'b'
                      { op: "i32.eq" },
                      {
                        op: "if",
                        blockType: { kind: "val", type: i32 },
                        then: [{ op: "i32.const", value: 8 }],
                        else: [
                          { op: "local.get", index: S_C },
                          { op: "i32.const", value: 102 }, // 'f'
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "val", type: i32 },
                            then: [{ op: "i32.const", value: 12 }],
                            else: [
                              { op: "local.get", index: S_C },
                              { op: "i32.const", value: 110 }, // 'n'
                              { op: "i32.eq" },
                              {
                                op: "if",
                                blockType: { kind: "val", type: i32 },
                                then: [{ op: "i32.const", value: 10 }],
                                else: [
                                  { op: "local.get", index: S_C },
                                  { op: "i32.const", value: 114 }, // 'r'
                                  { op: "i32.eq" },
                                  {
                                    op: "if",
                                    blockType: { kind: "val", type: i32 },
                                    then: [{ op: "i32.const", value: 13 }],
                                    else: [
                                      { op: "local.get", index: S_C },
                                      { op: "i32.const", value: 116 }, // 't'
                                      { op: "i32.eq" },
                                      {
                                        op: "if",
                                        blockType: { kind: "val", type: i32 },
                                        then: [{ op: "i32.const", value: 9 }],
                                        else: [{ op: "local.get", index: S_C }],
                                      },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ]),
                    ...sAdvance,
                  ],
                },
              ],
              else: [...sEmit([{ op: "local.get", index: S_C }]), ...sAdvance],
            },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // advance past closing quote, write cursor back into p.pos
    { op: "local.get", index: S_RAWEND },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: S_POS },
    { op: "local.get", index: S_PS },
    { op: "local.get", index: S_POS },
    { op: "struct.set", typeIdx: jsonPTypeIdx, fieldIdx: 1 },
    // struct.new $NativeString(len=S_N, off=0, data=S_OUT)
    { op: "local.get", index: S_N },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: S_OUT },
    { op: "struct.new", typeIdx: strTypeIdx },
  ];

  // ════════════════════════════════════════════════════════════════════════
  // __json_parse_text(s: externref) -> anyref  (entry)
  // ════════════════════════════════════════════════════════════════════════
  const T_S = 0;
  const T_FLAT = 1; // ref $NativeString
  const T_P = 2; // ref $JsonP
  const T_RESULT = 3; // anyref
  const T_POS = 4; // i32
  const T_END = 5; // i32
  const T_DATA = 6; // ref $strData
  const T_C = 7; // i32

  const textBody: Instr[] = [
    { op: "local.get", index: T_S },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    { op: "ref.cast", typeIdx: strTypeIdx },
    { op: "local.set", index: T_FLAT },
    // p = struct.new $JsonP(flat.data, flat.off, flat.off+flat.len)
    { op: "local.get", index: T_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
    { op: "local.get", index: T_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
    { op: "local.get", index: T_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
    { op: "local.get", index: T_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
    { op: "i32.add" },
    { op: "struct.new", typeIdx: jsonPTypeIdx },
    { op: "local.set", index: T_P },
    // result = __json_parse_value(p)  — pass as anyref
    { op: "local.get", index: T_P },
    { op: "call", funcIdx: valueFuncIdx },
    { op: "local.set", index: T_RESULT },
    // trailing ws + EOF
    { op: "local.get", index: T_P },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: T_DATA },
    { op: "local.get", index: T_P },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: T_POS },
    { op: "local.get", index: T_P },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: T_END },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: T_POS },
            { op: "local.get", index: T_END },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: T_DATA },
            { op: "local.get", index: T_POS },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.set", index: T_C },
            { op: "local.get", index: T_C },
            { op: "i32.const", value: 32 },
            { op: "i32.eq" },
            { op: "local.get", index: T_C },
            { op: "i32.const", value: 9 },
            { op: "i32.eq" },
            { op: "i32.or" },
            { op: "local.get", index: T_C },
            { op: "i32.const", value: 10 },
            { op: "i32.eq" },
            { op: "i32.or" },
            { op: "local.get", index: T_C },
            { op: "i32.const", value: 13 },
            { op: "i32.eq" },
            { op: "i32.or" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: T_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: T_POS },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: T_POS },
    { op: "local.get", index: T_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: throwSyntaxError("Unexpected non-whitespace character after JSON"),
    },
    { op: "local.get", index: T_RESULT },
  ];

  // ── push the three functions in the pre-registered order ──────────────────
  // Deep-clone each body so no `Instr` object is shared between (or within) the
  // bodies. The helper consts above (`loadPos`, `storePos`, `cEqV(...)`, …) are
  // shared `Instr[]` arrays spread into many positions, so the SAME object
  // appears at multiple slots in one body. The finalize remap
  // (`remapTypeIdxInBody` in dead-elimination.ts) mutates `typeIdx` IN PLACE and
  // re-visits a shared object once per occurrence, re-mapping an already-mapped
  // index a second (third, …) time — the documented #1302 shared-array
  // double-shift hazard. It desynced the `$JsonP` `$pos` `struct.get`/`struct.set`
  // operands (spread the most) from the cursor local's declared type
  // (`expected (ref 54 $ProxyTraps), found (ref 72 $JsonP)`).
  //
  // NOTE: `structuredClone` is NOT sufficient — it *preserves* internal
  // aliasing, so a shared object stays shared (just freshly) and is still
  // re-visited N times. The JSON round-trip below *expands* every shared
  // reference into an independent copy, so each `typeIdx` operand is remapped
  // exactly once. Bodies hold only plain JSON-safe data (no funcs/cycles).
  const cloneBody = (b: Instr[]): Instr[] => JSON.parse(JSON.stringify(b)) as Instr[];

  ctx.mod.functions.push({
    name: "__json_parse_value",
    typeIdx: valueTypeIdx,
    locals: [
      { count: 1, type: { kind: "ref", typeIdx: jsonPTypeIdx } }, // V_PS
      { count: 1, type: strDataRef }, // V_DATA
      { count: 1, type: i32 }, // V_POS
      { count: 1, type: i32 }, // V_END
      { count: 1, type: i32 }, // V_C
      { count: 1, type: externref }, // V_OBJ
      { count: 1, type: strRefNative }, // V_KEY
      { count: 1, type: anyref }, // V_VAL
      { count: 1, type: f64 }, // V_NUM
      { count: 1, type: f64 }, // V_MANT
      { count: 1, type: f64 }, // V_SIGN
      { count: 1, type: i32 }, // V_EXP
      { count: 1, type: i32 }, // V_EXPSIGN
      { count: 1, type: i32 }, // V_EXPMAG
    ],
    body: cloneBody(valueBody),
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  ctx.mod.functions.push({
    name: "__json_parse_str",
    typeIdx: strParseTypeIdx,
    locals: [
      { count: 1, type: { kind: "ref", typeIdx: jsonPTypeIdx } }, // S_PS
      { count: 1, type: strDataRef }, // S_DATA
      { count: 1, type: i32 }, // S_POS
      { count: 1, type: i32 }, // S_END
      { count: 1, type: i32 }, // S_START
      { count: 1, type: i32 }, // S_RAWEND
      { count: 1, type: strDataRef }, // S_OUT
      { count: 1, type: i32 }, // S_N
      { count: 1, type: i32 }, // S_C
      { count: 1, type: i32 }, // S_HEX
      { count: 1, type: i32 }, // S_K
      { count: 1, type: i32 }, // S_SCAN
    ],
    body: cloneBody(strParseBody),
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  ctx.mod.functions.push({
    name: "__json_parse_text",
    typeIdx: textTypeIdx,
    locals: [
      { count: 1, type: strRefNative }, // T_FLAT
      { count: 1, type: { kind: "ref", typeIdx: jsonPTypeIdx } }, // T_P
      { count: 1, type: anyref }, // T_RESULT
      { count: 1, type: i32 }, // T_POS
      { count: 1, type: i32 }, // T_END
      { count: 1, type: strDataRef }, // T_DATA
      { count: 1, type: i32 }, // T_C
    ],
    body: cloneBody(textBody),
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  return textFuncIdx;
}

/**
 * (#2166 PR-D1) Emit the standalone `JSON.parse(text, reviver)` codec —
 * `__json_parse_text_reviver(text: externref, reviver: externref) -> anyref` —
 * and the recursive §25.5.1 InternalizeJSONProperty walk
 * `__internalize_json_property(holder: externref, key: externref,
 * reviver: externref) -> externref`. Idempotent. Standalone / WASI only.
 *
 * The reviver itself is a USER closure (externref). It is invoked via the
 * reserve/fill `__call_reviver` driver (accessor-driver.ts) which wraps
 * `__call_fn_method_2(holder, reviver, key, value)` — binding `holder` as `this`
 * and passing `key`/`value` as the two reviver args (§25.5.1 step 2.c). The fill
 * runs in finalize after `__call_fn_method_2` is registered; when no arity-2
 * closure exists the driver degrades to an identity (returns the value), so a
 * module with no reviver closure still verifies.
 *
 * Walk (§25.5.1 InternalizeJSONProperty(holder, key, reviver)):
 *   val = holder[key]
 *   if val is an Object: for each own key k (snapshot taken BEFORE recursion,
 *     §25.5.1 step 2.a.i — a reviver that adds keys doesn't see them):
 *       elem = InternalizeJSONProperty(val, k, reviver)
 *       if elem is undefined → delete val[k]   else → val[k] = elem
 *   if val is an Array ($ObjVec): same over numeric indices with string keys.
 *   return reviver.call(holder, key, val)
 *
 * Returns the funcIdx of `__json_parse_text_reviver`.
 */
export function emitJsonParseTextReviver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_parse_text_reviver");
  if (existing !== undefined) return existing;

  // Dependencies (all idempotent). The base parser + object runtime + the
  // number formatter (for array index → string keys) + the reviver driver.
  const parseTextIdx = emitJsonParseText(ctx);
  ensureNativeStringHelpers(ctx);
  const objTypes = ensureObjectRuntime(ctx);
  emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  const reviverDriverIdx = reserveReviverDriver(ctx);

  const newObjIdx = ctx.funcMap.get("__new_plain_object")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  const externGetIdx = ctx.funcMap.get("__extern_get")!;
  const deleteIdx = ctx.funcMap.get("__delete_property")!;
  const orderedIdx = ctx.funcMap.get("__obj_ordered")!;
  const numToStrIdx = ctx.funcMap.get("number_toString")!;

  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const anyref: ValType = { kind: "anyref" };
  const externref: ValType = { kind: "externref" };

  const objectTypeIdx = objTypes.objectTypeIdx;
  const propMapTypeIdx = objTypes.propMapTypeIdx;
  const propEntryTypeIdx = objTypes.propEntryTypeIdx;
  const objVecTypeIdx = objTypes.objVecTypeIdx;
  const objVecArrTypeIdx = objTypes.objVecArrTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;

  // Pre-register the recursive internalize funcIdx so the body can call itself.
  // (#2166 PR-D1) Signature takes the VALUE directly (already fetched by the
  // caller) plus the holder+key for the reviver's `this`/key args. This is
  // load-bearing: an `$ObjVec` array element CANNOT be re-read via
  // `__extern_get(holder, "i")` (the vec has no string-keyed property), so each
  // arm fetches its child with the right primitive (`__extern_get` for object
  // props, `array.get` for array elements) and passes the value in.
  //
  // __internalize_json_value(val, holder, key, reviver) -> externref
  const internTypeIdx = addFuncType(ctx, [externref, externref, externref, externref], [externref]);
  const internFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__internalize_json_value", internFuncIdx);

  // params: 0=val 1=holder 2=key 3=reviver
  const P_VAL = 0;
  const P_HOLDER = 1;
  const P_KEY = 2;
  const P_REVIVER = 3;
  const L_ANY = 4; // anyref — val widened for ref.test
  const L_ARR = 5; // ref null $PropMap — ordered key snapshot
  const L_CAP = 6; // i32 — loop bound
  const L_I = 7; // i32 — loop index
  const L_E = 8; // ref null $PropEntry
  const L_K = 9; // externref — current child key
  const L_CHILD = 10; // externref — child value (pre-reviver)
  const L_ELEM = 11; // externref — internalized child value
  const L_VEC = 12; // ref null $ObjVec
  const L_DATA = 13; // ref $ObjVecArr
  const L_OBJREF = 14; // externref — the $Object/$ObjVec value re-as-externref

  const internBody: Instr[] = [
    // any = any.convert_extern(val)
    { op: "local.get", index: P_VAL },
    { op: "any.convert_extern" },
    { op: "local.set", index: L_ANY },
    // ── $Object arm ───────────────────────────────────────────────────────
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // objref = val (the object, as externref holder for its children)
        { op: "local.get", index: P_VAL },
        { op: "local.set", index: L_OBJREF },
        // arr = __obj_ordered(cast<$Object>(any))  — snapshot BEFORE recursion
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "call", funcIdx: orderedIdx },
        { op: "local.set", index: L_ARR },
        { op: "local.get", index: L_ARR },
        { op: "array.len" },
        { op: "local.set", index: L_CAP },
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
                // k = extern.convert_any(e.key)
                { op: "local.get", index: L_E },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 }, // key: ref $AnyString
                { op: "extern.convert_any" },
                { op: "local.set", index: L_K },
                // child = __extern_get(objref, k)
                { op: "local.get", index: L_OBJREF },
                { op: "local.get", index: L_K },
                { op: "call", funcIdx: externGetIdx },
                { op: "local.set", index: L_CHILD },
                // elem = __internalize_json_value(child, objref, k, reviver)
                { op: "local.get", index: L_CHILD },
                { op: "local.get", index: L_OBJREF },
                { op: "local.get", index: L_K },
                { op: "local.get", index: P_REVIVER },
                { op: "call", funcIdx: internFuncIdx },
                { op: "local.set", index: L_ELEM },
                // if elem is undefined (null externref) → delete; else set
                { op: "local.get", index: L_ELEM },
                { op: "ref.is_null" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: L_OBJREF },
                    { op: "local.get", index: L_K },
                    { op: "call", funcIdx: deleteIdx },
                    { op: "drop" },
                  ],
                  else: [
                    { op: "local.get", index: L_OBJREF },
                    { op: "local.get", index: L_K },
                    { op: "local.get", index: L_ELEM },
                    { op: "call", funcIdx: externSetIdx },
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
      ],
    },
    // ── $ObjVec (array) arm ───────────────────────────────────────────────
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: objVecTypeIdx },
        { op: "local.tee", index: L_VEC },
        { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 }, // data
        { op: "local.set", index: L_DATA },
        { op: "local.get", index: L_VEC },
        { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 }, // len
        { op: "local.set", index: L_CAP },
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
                // k = number_toString(f64(i))  — array index → string key
                { op: "local.get", index: L_I },
                { op: "f64.convert_i32_s" },
                { op: "call", funcIdx: numToStrIdx },
                { op: "local.set", index: L_K },
                // child = data[i]  (read the element directly — NOT via __extern_get)
                { op: "local.get", index: L_DATA },
                { op: "local.get", index: L_I },
                { op: "array.get", typeIdx: objVecArrTypeIdx },
                { op: "local.set", index: L_CHILD },
                // elem = __internalize_json_value(child, val, k, reviver)
                { op: "local.get", index: L_CHILD },
                { op: "local.get", index: P_VAL },
                { op: "local.get", index: L_K },
                { op: "local.get", index: P_REVIVER },
                { op: "call", funcIdx: internFuncIdx },
                { op: "local.set", index: L_ELEM },
                // §25.5.1 step 2.b.ii: a non-undefined result replaces the
                // element in place; undefined → CreateDataProperty(undefined)
                // (store the null externref / a JSON `null` hole).
                { op: "local.get", index: L_DATA },
                { op: "local.get", index: L_I },
                { op: "local.get", index: L_ELEM },
                { op: "array.set", typeIdx: objVecArrTypeIdx },
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // ── return reviver.call(holder, key, val) via the driver ──────────────
    { op: "local.get", index: P_HOLDER }, // holder (this)
    { op: "local.get", index: P_REVIVER }, // reviver closure
    { op: "local.get", index: P_KEY }, // key
    { op: "local.get", index: P_VAL }, // value
    { op: "call", funcIdx: reviverDriverIdx },
  ];

  ctx.mod.functions.push({
    name: "__internalize_json_value",
    typeIdx: internTypeIdx,
    locals: [
      { count: 1, type: anyref }, // L_ANY
      { count: 1, type: { kind: "ref_null", typeIdx: propMapTypeIdx } }, // L_ARR
      { count: 1, type: i32 }, // L_CAP
      { count: 1, type: i32 }, // L_I
      { count: 1, type: { kind: "ref_null", typeIdx: propEntryTypeIdx } }, // L_E
      { count: 1, type: externref }, // L_K
      { count: 1, type: externref }, // L_CHILD
      { count: 1, type: externref }, // L_ELEM
      { count: 1, type: { kind: "ref_null", typeIdx: objVecTypeIdx } }, // L_VEC
      { count: 1, type: { kind: "ref", typeIdx: objVecArrTypeIdx } }, // L_DATA
      { count: 1, type: externref }, // L_OBJREF
    ],
    body: internBody,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  // ── __json_parse_text_reviver(text, reviver) -> anyref ────────────────────
  // val = __json_parse_text(text); root = { "": val };
  // return any.convert_extern(
  //          __internalize_json_value(val, root, "", reviver)).
  const rootTypeIdx = addFuncType(ctx, [externref, externref], [anyref]);
  const rootFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__json_parse_text_reviver", rootFuncIdx);

  void anyStrTypeIdx;
  const emptyKey = (): Instr[] => nativeStringLiteralInstrs(ctx, "");
  const R_ROOT = 2; // externref
  const R_VAL = 3; // externref — the parsed root value

  const rootBody: Instr[] = [
    // val = any.convert_extern(__json_parse_text(text))
    { op: "local.get", index: 0 }, // text
    { op: "call", funcIdx: parseTextIdx }, // -> anyref value graph
    { op: "extern.convert_any" },
    { op: "local.set", index: R_VAL },
    // root = __new_plain_object(); root[""] = val
    { op: "call", funcIdx: newObjIdx },
    { op: "local.set", index: R_ROOT },
    { op: "local.get", index: R_ROOT },
    ...emptyKey(),
    { op: "extern.convert_any" },
    { op: "local.get", index: R_VAL },
    { op: "call", funcIdx: externSetIdx },
    // return any.convert_extern(__internalize_json_value(val, root, "", reviver))
    { op: "local.get", index: R_VAL },
    { op: "local.get", index: R_ROOT },
    ...emptyKey(),
    { op: "extern.convert_any" },
    { op: "local.get", index: 1 }, // reviver
    { op: "call", funcIdx: internFuncIdx },
    { op: "any.convert_extern" }, // back to anyref (the parse codec's result type)
  ];

  ctx.mod.functions.push({
    name: "__json_parse_text_reviver",
    typeIdx: rootTypeIdx,
    locals: [
      { count: 1, type: externref }, // R_ROOT (index 2)
      { count: 1, type: externref }, // R_VAL (index 3)
    ],
    body: rootBody,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  return rootFuncIdx;
}
