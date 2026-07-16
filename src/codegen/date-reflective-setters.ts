// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3174) Reflective `Date.prototype.set*` / `toISOString` closure bodies for
 * `--target standalone` — the setter/formatter counterpart of the #3219
 * reflective getter bodies in `emitDateProtoMemberBody`.
 *
 * `Date.prototype.setTime.call(recv, v)` (and every other setter) previously
 * fell through to the legacy value-erased `.call` lowering: no [[DateValue]]
 * brand check (§21.4.4.20–27 step 1 `thisTimeValue` must throw TypeError on a
 * non-Date receiver BEFORE any argument coercion — test262
 * `this-value-non-date.js` / `this-value-non-object.js` assert exactly the
 * "validation precedes input coercion" order), no mutation on a genuine Date,
 * and a garbage return value. This module mints real closure bodies:
 *
 *   1. Shared receiver-brand preamble (`emitReceiverBrandCheck`, #3171/#3192)
 *      against the `$__Date` struct — a catchable TypeError on a brand miss.
 *   2. [[DateValue]] read BEFORE argument coercion (observable order —
 *      test262 `date-value-read-before-tonumber-*`).
 *   3. Left-to-right §7.1.4 ToNumber argument coercion via the native
 *      `__to_primitive(v,"number")` + `__unbox_number` funnel (#2891 lineage —
 *      NO Date-local ToPrimitive copy), with runtime absence detection: the
 *      reflective-call ABI pads missing args with `ref.null.extern`, so
 *      `ref.is_null` distinguishes `setHours(1)` (keep current minutes) from a
 *      supplied argument. (An explicitly-passed `undefined`/`null` also
 *      arrives as a null externref in the legacy any-representation, so it is
 *      treated as absent — a known corner shared with the closure ABI.)
 *   4. The same i64 timestamp arithmetic as the direct-call kernel
 *      (`compileDateMethodCall`, expressions/builtins.ts): floor-mod
 *      ms-of-day rebuild for the time-of-day family, Hinnant
 *      civil_from_days/days_from_civil round-trip for the calendar family,
 *      §21.4.1.31 TimeClip (|t| > 8.64e15 → Invalid-Date sentinel + NaN), and
 *      the §21.4.4.21 setFullYear invalid-receiver re-validation (t → +0).
 *
 * `toISOString` (§21.4.4.36) gets the same brand preamble; a NaN [[DateValue]]
 * throws a catchable RangeError, a valid one renders via the existing
 * `__date_iso_string` pure-Wasm formatter.
 *
 * Results are boxed to externref (`__box_number` / `extern.convert_any`) — the
 * uniform closure-call result type, matching the #3219 getter bodies.
 *
 * Standalone-only by construction: only the native-proto glue
 * (array-object-proto.ts `makeGlue("Date")`) calls this, and that path exists
 * only under `--target standalone`/`wasi`. The direct-call kernel and the JS
 * host lane are byte-identical.
 */
import type { Instr, ValType } from "../ir/types.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  ensureDateCivilHelper,
  ensureDateDaysFromCivilHelper,
  ensureDateIsoStringHelper,
  ensureDateStruct,
  emitPackedYear,
} from "./expressions/builtins.js";
import { emitThrowRangeError } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitReceiverBrandCheck } from "./receiver-brand.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

const SENTINEL = -9223372036854775808n; // Invalid-Date [[DateValue]] sentinel (i64 min).
const MS_PER_DAY = 86400000n;
const MS_PER_HOUR = 3600000n;
const MS_PER_MINUTE = 60000n;
const MS_PER_SECOND = 1000n;
const MAX_TIME = 8640000000000000n; // §21.4.1.31 TimeClip bound (8.64e15 ms).

const BRAND_MSG = "Date.prototype method called on a non-Date receiver";

type TimeUnit = "h" | "m" | "s" | "ms";
type CalUnit = "y" | "mo" | "d";

/** Time-of-day setters → start index into ["h","m","s","ms"] (§21.4.4.23–30). */
const TIME_SETTERS: Record<string, number> = {
  setHours: 0,
  setUTCHours: 0,
  setMinutes: 1,
  setUTCMinutes: 1,
  setSeconds: 2,
  setUTCSeconds: 2,
  setMilliseconds: 3,
  setUTCMilliseconds: 3,
};

/** Calendar setters → start index into ["y","mo","d"] (§21.4.4.20/21/24/…). */
const CAL_SETTERS: Record<string, number> = {
  setFullYear: 0,
  setUTCFullYear: 0,
  setMonth: 1,
  setUTCMonth: 1,
  setDate: 2,
  setUTCDate: 2,
};

const TIME_UNITS: readonly TimeUnit[] = ["h", "m", "s", "ms"];
const CAL_UNITS: readonly CalUnit[] = ["y", "mo", "d"];

const i64c = (v: bigint): Instr => ({ op: "i64.const", value: v });

/**
 * Emit the shared setter prologue: brand check + [[DateValue]] read + L→R
 * argument coercion with runtime absence flags. Returns the allocated locals.
 * The caller must release them.
 */
function emitSetterPrologue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  dateTypeIdx: number,
  arity: number,
  toPrimIdx: number,
  unboxIdx: number,
): { dateRef: number; curTs: number; vals: number[]; presents: number[] } {
  // this (param 1) → validated (ref $__Date). Brand miss throws a catchable
  // TypeError — §thisTimeValue step 2 — BEFORE any ToNumber side effect runs
  // ("validation precedes input coercion").
  fctx.body.push({ op: "local.get", index: 1 });
  emitReceiverBrandCheck(ctx, fctx, { kind: "externref" }, { message: BRAND_MSG, structTypeIdx: dateTypeIdx });
  const dateRef = allocTempLocal(fctx, { kind: "ref", typeIdx: dateTypeIdx });
  fctx.body.push({ op: "local.set", index: dateRef });

  // Read [[DateValue]] BEFORE argument coercion (observable order).
  const curTs = allocTempLocal(fctx, { kind: "i64" });
  fctx.body.push({ op: "local.get", index: dateRef });
  fctx.body.push({ op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: curTs });

  // Coerce args LEFT-TO-RIGHT (each __to_primitive may throw — Symbol arg,
  // abrupt valueOf). Absent (null-padded) slots skip coercion and record
  // present=0; the leading slot's value defaults to NaN (ToNumber(undefined)).
  const vals: number[] = [];
  const presents: number[] = [];
  for (let i = 0; i < arity; i++) {
    const present = allocTempLocal(fctx, { kind: "i32" });
    const val = allocTempLocal(fctx, { kind: "f64" });
    presents.push(present);
    vals.push(val);
    fctx.body.push({ op: "local.get", index: 2 + i });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({ op: "local.tee", index: present });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "local.get", index: 2 + i },
        ...stringConstantExternrefInstrs(ctx, "number"),
        { op: "call", funcIdx: toPrimIdx },
        { op: "call", funcIdx: unboxIdx },
      ],
      else: [{ op: "f64.const", value: NaN }],
    });
    fctx.body.push({ op: "local.set", index: val });
  }
  return { dateRef, curTs, vals, presents };
}

/**
 * Emit `anyInvalid` (i32 on the stack): slot 0 always contributes
 * `isNaN(val)||{|val|>8.64e15}` (an absent leading arg coerced to NaN above);
 * slots > 0 contribute only when present (absent trailing args keep the
 * current component and never invalidate).
 */
function emitAnyInvalid(fctx: FunctionContext, vals: number[], presents: number[]): void {
  for (let i = 0; i < vals.length; i++) {
    const val = vals[i]!;
    const inv: Instr[] = [
      { op: "local.get", index: val },
      { op: "local.get", index: val },
      { op: "f64.ne" },
      { op: "local.get", index: val },
      { op: "f64.abs" },
      { op: "f64.const", value: 8.64e15 },
      { op: "f64.gt" },
      { op: "i32.or" },
    ];
    if (i === 0) {
      fctx.body.push(...inv);
    } else {
      fctx.body.push({ op: "local.get", index: presents[i]! });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: inv,
        else: [{ op: "i32.const", value: 0 }],
      });
      fctx.body.push({ op: "i32.or" });
    }
  }
}

/** Emit floor-div(ts, MS_PER_DAY) with `ts` read from `tsLocal`; i64 result on the stack. */
function emitFloorDays(fctx: FunctionContext, tsLocal: number): void {
  fctx.body.push({ op: "local.get", index: tsLocal });
  fctx.body.push(i64c(0n));
  fctx.body.push({ op: "i64.ge_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i64" } },
    then: [{ op: "local.get", index: tsLocal }, i64c(MS_PER_DAY), { op: "i64.div_s" }],
    else: [
      { op: "local.get", index: tsLocal },
      i64c(MS_PER_DAY - 1n),
      { op: "i64.sub" },
      i64c(MS_PER_DAY),
      { op: "i64.div_s" },
    ],
  });
}

/** TimeClip + store + f64 result (mirrors the direct kernel's tail). Consumes nothing; reads `newTs`. */
function emitTimeClipStore(fctx: FunctionContext, dateTypeIdx: number, dateRef: number, newTs: number): void {
  fctx.body.push({ op: "local.get", index: newTs });
  fctx.body.push(i64c(MAX_TIME));
  fctx.body.push({ op: "i64.gt_s" });
  fctx.body.push({ op: "local.get", index: newTs });
  fctx.body.push(i64c(-MAX_TIME));
  fctx.body.push({ op: "i64.lt_s" });
  fctx.body.push({ op: "i32.or" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: [
      { op: "local.get", index: dateRef },
      i64c(SENTINEL),
      { op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 },
      { op: "f64.const", value: NaN },
    ],
    else: [
      { op: "local.get", index: dateRef },
      { op: "local.get", index: newTs },
      { op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 },
      { op: "local.get", index: newTs },
      { op: "f64.convert_i64_s" },
    ],
  });
}

/**
 * Invalid-result arm shared by the non-re-validating setters: the spec's "If t
 * is NaN, return NaN" returns WITHOUT writing when the receiver was ALREADY
 * invalid (a ToNumber side effect may have legitimately re-set [[DateValue]] —
 * test262 `date-value-read-before-tonumber-when-date-is-invalid`); only a
 * still-valid receiver invalidated by a bad arg stores the sentinel.
 */
function invalidArmInstrs(dateTypeIdx: number, dateRef: number, curTs: number): Instr[] {
  return [
    { op: "local.get", index: curTs },
    i64c(SENTINEL),
    { op: "i64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: dateRef },
        i64c(SENTINEL),
        { op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 },
      ],
    },
    { op: "f64.const", value: NaN },
  ];
}

/**
 * Mint the reflective closure body for a `Date.prototype` setter or
 * `toISOString`. Closure ABI: `(self, this: externref, ...args: externref) ->
 * externref`. Returns the externref result type, or `null` for any other
 * member (caller falls through to the legacy path unchanged).
 */
export function emitDateReflectiveSetterBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | null {
  const isTime = Object.prototype.hasOwnProperty.call(TIME_SETTERS, member);
  const isCal = Object.prototype.hasOwnProperty.call(CAL_SETTERS, member);
  const isSetTime = member === "setTime";
  const isIso = member === "toISOString";
  if (!isTime && !isCal && !isSetTime && !isIso) return null;

  // Ensure every possibly-import-adding helper FIRST, then flush, so the
  // funcidx values captured below are shift-stable (#3219 discipline). Under
  // standalone these all resolve to defined natives (no env import leaks).
  const extern: ValType = { kind: "externref" };
  const toPrimIdx = ensureLateImport(ctx, "__to_primitive", [extern, extern], [extern]);
  const unboxIdx = ensureLateImport(ctx, "__unbox_number", [extern], [{ kind: "f64" }]);
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [extern]);
  if (toPrimIdx === undefined || unboxIdx === undefined || boxIdx === undefined) return null;
  addStringConstantGlobal(ctx, "number");
  flushLateImportShifts(ctx, fctx);
  const dateTypeIdx = ensureDateStruct(ctx);

  if (isIso) {
    // §21.4.4.36: brand check, RangeError on an Invalid Date, else render.
    const isoIdx = ensureDateIsoStringHelper(ctx);
    fctx.body.push({ op: "local.get", index: 1 });
    emitReceiverBrandCheck(ctx, fctx, extern, { message: BRAND_MSG, structTypeIdx: dateTypeIdx });
    fctx.body.push({ op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 });
    const ts = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.tee", index: ts });
    fctx.body.push(i64c(SENTINEL));
    fctx.body.push({ op: "i64.eq" });
    const savedRange = pushBody(fctx);
    emitThrowRangeError(ctx, fctx, "Invalid time value");
    const rangeInstrs = fctx.body;
    popBody(fctx, savedRange);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeInstrs, else: [] });
    fctx.body.push({ op: "local.get", index: ts });
    fctx.body.push({ op: "call", funcIdx: isoIdx });
    fctx.body.push({ op: "extern.convert_any" });
    releaseTempLocal(fctx, ts);
    return { kind: "externref" };
  }

  const isSetFullYear = member === "setFullYear" || member === "setUTCFullYear";
  const startIdx = isTime ? TIME_SETTERS[member]! : isCal ? CAL_SETTERS[member]! : 0;
  const arity = isSetTime ? 1 : isTime ? 4 - startIdx : 3 - startIdx;

  const { dateRef, curTs, vals, presents } = emitSetterPrologue(ctx, fctx, dateTypeIdx, arity, toPrimIdx, unboxIdx);

  if (isSetTime) {
    // §21.4.4.27: v = TimeClip(ToNumber(time)); [[DateValue]] = v; return v —
    // no receiver-invalid early return (only the brand check gates).
    emitAnyInvalid(fctx, vals, presents); // arity 1 → just the NaN/range test
    const savedThen = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: dateRef });
    fctx.body.push(i64c(SENTINEL));
    fctx.body.push({ op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "f64.const", value: NaN });
    const thenInstrs = fctx.body;
    popBody(fctx, savedThen);
    const savedElse = pushBody(fctx);
    const newTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: dateRef });
    fctx.body.push({ op: "local.get", index: vals[0]! });
    fctx.body.push({ op: "i64.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.tee", index: newTs });
    fctx.body.push({ op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.get", index: newTs });
    fctx.body.push({ op: "f64.convert_i64_s" });
    releaseTempLocal(fctx, newTs);
    const elseInstrs = fctx.body;
    popBody(fctx, savedElse);
    fctx.body.push({ op: "if", blockType: { kind: "val", type: { kind: "f64" } }, then: thenInstrs, else: elseInstrs });
  } else if (isTime) {
    // isInvalid = anyInvalid | (curTs == sentinel)
    emitAnyInvalid(fctx, vals, presents);
    fctx.body.push({ op: "local.get", index: curTs });
    fctx.body.push(i64c(SENTINEL));
    fctx.body.push({ op: "i64.eq" });
    fctx.body.push({ op: "i32.or" });

    const savedElse = pushBody(fctx);
    // msOfDay = floormod(curTs, DAY); dayMs = curTs - msOfDay
    const msOfDay = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push(
      { op: "local.get", index: curTs },
      i64c(MS_PER_DAY),
      { op: "i64.rem_s" },
      i64c(MS_PER_DAY),
      { op: "i64.add" },
      i64c(MS_PER_DAY),
      { op: "i64.rem_s" },
      { op: "local.set", index: msOfDay },
    );
    // Component value (i64 on the stack): supplied slot (runtime-present) →
    // trunc(val); absent / no slot → current component from msOfDay.
    const currentComponent = (unit: TimeUnit): Instr[] => {
      const out: Instr[] = [{ op: "local.get", index: msOfDay }];
      if (unit === "ms") out.push(i64c(MS_PER_SECOND), { op: "i64.rem_s" });
      else if (unit === "s") out.push(i64c(MS_PER_SECOND), { op: "i64.div_s" }, i64c(60n), { op: "i64.rem_s" });
      else if (unit === "m") out.push(i64c(MS_PER_MINUTE), { op: "i64.div_s" }, i64c(60n), { op: "i64.rem_s" });
      else out.push(i64c(MS_PER_HOUR), { op: "i64.div_s" });
      return out;
    };
    const pushComponent = (unit: TimeUnit): void => {
      const slot = TIME_UNITS.indexOf(unit) - startIdx;
      if (slot < 0 || slot >= arity) {
        fctx.body.push(...currentComponent(unit));
        return;
      }
      fctx.body.push({ op: "local.get", index: presents[slot]! });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: [{ op: "local.get", index: vals[slot]! }, { op: "i64.trunc_sat_f64_s" }],
        else: currentComponent(unit),
      });
    };
    // newTs = (curTs - msOfDay) + h*HOUR + m*MIN + s*SEC + ms
    fctx.body.push({ op: "local.get", index: curTs });
    fctx.body.push({ op: "local.get", index: msOfDay });
    fctx.body.push({ op: "i64.sub" });
    pushComponent("h");
    fctx.body.push(i64c(MS_PER_HOUR), { op: "i64.mul" }, { op: "i64.add" });
    pushComponent("m");
    fctx.body.push(i64c(MS_PER_MINUTE), { op: "i64.mul" }, { op: "i64.add" });
    pushComponent("s");
    fctx.body.push(i64c(MS_PER_SECOND), { op: "i64.mul" }, { op: "i64.add" });
    pushComponent("ms");
    fctx.body.push({ op: "i64.add" });
    const newTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: newTs });
    emitTimeClipStore(fctx, dateTypeIdx, dateRef, newTs);
    releaseTempLocal(fctx, newTs);
    releaseTempLocal(fctx, msOfDay);
    const elseInstrs = fctx.body;
    popBody(fctx, savedElse);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: invalidArmInstrs(dateTypeIdx, dateRef, curTs),
      else: elseInstrs,
    });
  } else {
    // Calendar family. setFullYear (§21.4.4.21) re-validates an Invalid
    // receiver (t → +0) and writes unconditionally on a bad arg; the others
    // early-return NaN on an invalid receiver.
    emitAnyInvalid(fctx, vals, presents);
    if (!isSetFullYear) {
      fctx.body.push({ op: "local.get", index: curTs });
      fctx.body.push(i64c(SENTINEL));
      fctx.body.push({ op: "i64.eq" });
      fctx.body.push({ op: "i32.or" });
    }

    const savedThen = pushBody(fctx);
    if (isSetFullYear) {
      fctx.body.push({ op: "local.get", index: dateRef });
      fctx.body.push(i64c(SENTINEL));
      fctx.body.push({ op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "f64.const", value: NaN });
    } else {
      fctx.body.push(...invalidArmInstrs(dateTypeIdx, dateRef, curTs));
    }
    const thenInstrs = fctx.body;
    popBody(fctx, savedThen);

    const savedElse = pushBody(fctx);
    // effTs: setFullYear re-validates sentinel → 0.
    const effTs = allocTempLocal(fctx, { kind: "i64" });
    if (isSetFullYear) {
      fctx.body.push({ op: "local.get", index: curTs });
      fctx.body.push(i64c(SENTINEL));
      fctx.body.push({ op: "i64.eq" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: [i64c(0n)],
        else: [{ op: "local.get", index: curTs }],
      });
      fctx.body.push({ op: "local.set", index: effTs });
    } else {
      fctx.body.push({ op: "local.get", index: curTs });
      fctx.body.push({ op: "local.set", index: effTs });
    }

    // msOfDay = floormod(effTs, DAY) — preserved into the new date.
    const msOfDay = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push(
      { op: "local.get", index: effTs },
      i64c(MS_PER_DAY),
      { op: "i64.rem_s" },
      i64c(MS_PER_DAY),
      { op: "i64.add" },
      i64c(MS_PER_DAY),
      { op: "i64.rem_s" },
      { op: "local.set", index: msOfDay },
    );

    // packed = civil_from_days(floor(effTs / DAY)) → curY / curMo(1-based) / curD.
    const civilIdx = ensureDateCivilHelper(ctx);
    emitFloorDays(fctx, effTs);
    fctx.body.push({ op: "call", funcIdx: civilIdx });
    const packed = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: packed });
    const curY = allocTempLocal(fctx, { kind: "i64" });
    const scratch = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: packed });
    emitPackedYear(fctx.body, scratch); // floor(packed/10000) on the stack
    fctx.body.push({ op: "local.set", index: curY });
    const curMmdd = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push(
      { op: "local.get", index: packed },
      { op: "local.get", index: curY },
      i64c(10000n),
      { op: "i64.mul" },
      { op: "i64.sub" },
      { op: "local.set", index: curMmdd },
    );
    releaseTempLocal(fctx, scratch);

    // Component (i64 on the stack): supplied slot → trunc(val) (+1 for the
    // 0-based month arg → 1-based helper); absent / no slot → current.
    const currentCal = (unit: CalUnit): Instr[] => {
      if (unit === "y") return [{ op: "local.get", index: curY }];
      if (unit === "mo") return [{ op: "local.get", index: curMmdd }, i64c(100n), { op: "i64.div_s" }];
      return [{ op: "local.get", index: curMmdd }, i64c(100n), { op: "i64.rem_s" }];
    };
    const pushCal = (unit: CalUnit): void => {
      const slot = CAL_UNITS.indexOf(unit) - startIdx;
      if (slot < 0 || slot >= arity) {
        fctx.body.push(...currentCal(unit));
        return;
      }
      const supplied: Instr[] = [{ op: "local.get", index: vals[slot]! }, { op: "i64.trunc_sat_f64_s" }];
      if (unit === "mo") supplied.push(i64c(1n), { op: "i64.add" });
      fctx.body.push({ op: "local.get", index: presents[slot]! });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: supplied,
        else: currentCal(unit),
      });
    };

    const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);
    pushCal("y");
    pushCal("mo");
    pushCal("d");
    fctx.body.push({ op: "call", funcIdx: daysFromCivilIdx });
    fctx.body.push(i64c(MS_PER_DAY), { op: "i64.mul" });
    fctx.body.push({ op: "local.get", index: msOfDay });
    fctx.body.push({ op: "i64.add" });
    const newTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: newTs });
    emitTimeClipStore(fctx, dateTypeIdx, dateRef, newTs);
    releaseTempLocal(fctx, newTs);
    releaseTempLocal(fctx, curMmdd);
    releaseTempLocal(fctx, curY);
    releaseTempLocal(fctx, packed);
    releaseTempLocal(fctx, msOfDay);
    releaseTempLocal(fctx, effTs);
    const elseInstrs = fctx.body;
    popBody(fctx, savedElse);

    fctx.body.push({ op: "if", blockType: { kind: "val", type: { kind: "f64" } }, then: thenInstrs, else: elseInstrs });
  }

  // Box the f64 time-value result to the uniform externref closure result.
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  for (const l of [...vals, ...presents]) releaseTempLocal(fctx, l);
  releaseTempLocal(fctx, curTs);
  releaseTempLocal(fctx, dateRef);
  return { kind: "externref" };
}
