// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm `Date.parse(str)` / `new Date(str)` for all targets (#2164).
 *
 * `Date.parse` was a NaN stub and `new Date("…")` coerced the string to f64
 * (→ NaN), so neither parsed a date string in any mode — fatal for standalone
 * (no JS host to fall back to). This module emits a WasmGC-native parser for
 * the ECMAScript Date Time String Format (ECMA-262 §21.4.1.32), registered
 * under `ctx.funcMap` as `__date_parse` with signature `(externref) -> f64`
 * (the time value in milliseconds since the epoch, or NaN on a parse failure).
 *
 * Supported grammar (§21.4.1.32):
 *   Date:        YYYY | YYYY-MM | YYYY-MM-DD          (also ±YYYYYY expanded year)
 *   Time:        THH:mm | THH:mm:ss | THH:mm:ss.sss
 *   TimeZone:    Z | ±HH:mm
 *   A date-time string may be `<Date>` or `<Date>T<Time><TimeZone?>`.
 * Per spec, a date-only form is UTC; a date-time form with no timezone is
 * local time — but a standalone/WASI module has no timezone database, so local
 * == UTC (offset 0), matching the deterministic-clock decision in slice 1.
 *
 * The string is read via the same flatten preamble as parse-number-native.ts:
 * `$NativeString` = { field0 len:i32, field1 off:i32, field2 data:i16-array }.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { ensureDateDaysFromCivilHelper } from "./expressions/builtins.js";
import { addFuncType } from "./registry/types.js";

const C_PLUS = 43;
const C_MINUS = 45;
const C_DOT = 46;
const C_COLON = 58;
const C_DASH = 45;
const C_T = 84; // 'T'
const C_t = 116; // 't' (lenient; spec is 'T' but some impls accept ' ' / 't')
const C_Z = 90; // 'Z'
const C_ZERO = 48;
const C_NINE = 57;

/**
 * Emit the native `__date_parse` helper if it is not already present.
 *
 * Locals (after param 0 = s:externref):
 *   1 flat:ref$NativeString  2 data:ref$i16arr  3 len:i32  4 i:i32  5 c:i32
 *   6 sign:i64 (year sign)   7 year:i64  8 month:i64  9 day:i64
 *  10 hour:i64 11 min:i64   12 sec:i64  13 ms:i64
 *  14 tzSign:i64 15 tzH:i64 16 tzM:i64
 *  17 fail:i32  18 acc:i64 (digit accumulator)  19 ndig:i32 (digits read)
 *  20 days:i64 (days-from-civil)  21 hasTime:i32  22 expanded:i32
 */
export function emitNativeDateParse(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__date_parse")) return;

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);

  const i32: ValType = { kind: "i32" };
  const i64: ValType = { kind: "i64" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };

  const typeIdx = addFuncType(ctx, [extern], [f64]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__date_parse", funcIdx);

  const L_FLAT = 1;
  const L_DATA = 2;
  const L_LEN = 3;
  const L_I = 4;
  const L_C = 5;
  const L_SIGN = 6;
  const L_YEAR = 7;
  const L_MONTH = 8;
  const L_DAY = 9;
  const L_HOUR = 10;
  const L_MIN = 11;
  const L_SEC = 12;
  const L_MS = 13;
  const L_TZSIGN = 14;
  const L_TZH = 15;
  const L_TZM = 16;
  const L_FAIL = 17;
  const L_ACC = 18;
  const L_NDIG = 19;
  const L_DAYS = 20;
  const L_HASTIME = 21;

  const getI = (l: number): Instr => ({ op: "local.get", index: l }) as Instr;
  const setI = (l: number): Instr => ({ op: "local.set", index: l }) as Instr;
  const i32c = (v: number): Instr => ({ op: "i32.const", value: v }) as Instr;
  const i64c = (v: bigint): Instr => ({ op: "i64.const", value: v }) as Instr;

  // c = data[i]  (no bounds check; callers guard i<len first via guarded blocks)
  const loadC: Instr[] = [getI(L_DATA), getI(L_I), { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr, setI(L_C)];

  /**
   * readDigits(n, dest): read exactly `n` decimal digits starting at `i` into
   * local `dest` (as i64), advancing `i`. If fewer than `n` digits are present
   * (end-of-string or a non-digit), set `fail`. Implemented as an unrolled loop
   * of `n` single-digit reads (n is small: 2, 3, 4 or 6).
   */
  const readDigits = (n: number, dest: number): Instr[] => {
    const out: Instr[] = [i64c(0n), setI(L_ACC)];
    for (let k = 0; k < n; k++) {
      // i >= len -> fail; else read one digit and advance
      out.push(
        getI(L_I),
        getI(L_LEN),
        { op: "i32.ge_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [i32c(1), setI(L_FAIL)],
          else: [
            ...loadC,
            // if c < '0' || c > '9' -> fail; else acc = acc*10 + (c-'0'); i++
            getI(L_C),
            i32c(C_ZERO),
            { op: "i32.lt_s" } as Instr,
            getI(L_C),
            i32c(C_NINE),
            { op: "i32.gt_s" } as Instr,
            { op: "i32.or" } as Instr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [i32c(1), setI(L_FAIL)],
              else: [
                getI(L_ACC),
                i64c(10n),
                { op: "i64.mul" } as Instr,
                getI(L_C),
                i32c(C_ZERO),
                { op: "i32.sub" } as Instr,
                { op: "i64.extend_i32_s" } as Instr,
                { op: "i64.add" } as Instr,
                setI(L_ACC),
                getI(L_I),
                i32c(1),
                { op: "i32.add" } as Instr,
                setI(L_I),
              ],
            } as Instr,
          ],
        } as Instr,
      );
    }
    out.push(getI(L_ACC), setI(dest));
    return out;
  };

  // expectChar(code): if (i<len && data[i]==code) i++; else fail.
  const expectChar = (code: number): Instr[] => [
    getI(L_I),
    getI(L_LEN),
    { op: "i32.lt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...loadC,
        getI(L_C),
        i32c(code),
        { op: "i32.eq" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I)],
          else: [i32c(1), setI(L_FAIL)],
        } as Instr,
      ],
      else: [i32c(1), setI(L_FAIL)],
    } as Instr,
  ];

  // peekIs(code) leaves i32 bool on stack: (i<len) && data[i]==code
  const peekIs = (code: number): Instr[] => [
    getI(L_I),
    getI(L_LEN),
    { op: "i32.lt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [...loadC, getI(L_C), i32c(code), { op: "i32.eq" } as Instr],
      else: [i32c(0)],
    } as Instr,
  ];

  // guard(body): run `body` only while no parse error has been recorded, so a
  // failure short-circuits the remaining stages and leaves the accumulators
  // well-defined. Emits `if (!fail) { … }`.
  const guard = (inner: Instr[]): Instr =>
    ({
      op: "if",
      blockType: { kind: "empty" },
      then: inner,
    }) as Instr;
  // guard prelude: push `!fail` before the if.
  const guarded = (inner: Instr[]): Instr[] => [getI(L_FAIL), { op: "i32.eqz" } as Instr, guard(inner)];

  const body: Instr[] = [
    // flatten
    getI(0),
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
    { op: "call", funcIdx: flattenIdx } as Instr,
    setI(L_FLAT),
    getI(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 } as Instr,
    setI(L_DATA),
    getI(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 } as Instr,
    setI(L_I), // i = off
    getI(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 } as Instr,
    getI(L_I),
    { op: "i32.add" } as Instr,
    setI(L_LEN), // len = off + len
    // field defaults: month=1 day=1 rest=0, sign=+1, tz offset 0
    i64c(1n),
    setI(L_SIGN),
    i64c(1n),
    setI(L_MONTH),
    i64c(1n),
    setI(L_DAY),
    i64c(0n),
    setI(L_HOUR),
    i64c(0n),
    setI(L_MIN),
    i64c(0n),
    setI(L_SEC),
    i64c(0n),
    setI(L_MS),
    i64c(0n),
    setI(L_TZSIGN), // 0 = no explicit TZ (treated as UTC standalone)
    i64c(0n),
    setI(L_TZH),
    i64c(0n),
    setI(L_TZM),
    i32c(0),
    setI(L_FAIL),
    i32c(0),
    setI(L_HASTIME),
  ];

  // --- Year: optional sign + 6 digits (expanded) OR 4 digits ---
  body.push(
    // expanded year: leading '+' or '-'
    ...peekIs(C_PLUS),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        getI(L_I),
        i32c(1),
        { op: "i32.add" } as Instr,
        setI(L_I),
        ...readDigits(6, L_YEAR),
        getI(L_YEAR),
        getI(L_SIGN),
        { op: "i64.mul" } as Instr,
        setI(L_YEAR),
      ],
      else: [
        ...peekIs(C_MINUS),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            getI(L_I),
            i32c(1),
            { op: "i32.add" } as Instr,
            setI(L_I),
            i64c(-1n),
            setI(L_SIGN),
            ...readDigits(6, L_YEAR),
            getI(L_YEAR),
            getI(L_SIGN),
            { op: "i64.mul" } as Instr,
            setI(L_YEAR),
          ],
          // plain 4-digit year
          else: [...readDigits(4, L_YEAR)],
        } as Instr,
      ],
    } as Instr,
  );

  // --- optional -MM ---
  body.push(
    ...guarded([
      ...peekIs(C_DASH),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          getI(L_I),
          i32c(1),
          { op: "i32.add" } as Instr,
          setI(L_I),
          ...readDigits(2, L_MONTH),
          // optional -DD
          ...peekIs(C_DASH),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I), ...readDigits(2, L_DAY)],
          } as Instr,
        ],
      } as Instr,
    ]),
  );

  // --- optional time: T HH:mm[:ss[.sss]] ---
  body.push(
    ...guarded([
      ...peekIs(C_T),
      ...peekIs(C_t),
      { op: "i32.or" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          i32c(1),
          setI(L_HASTIME),
          getI(L_I),
          i32c(1),
          { op: "i32.add" } as Instr,
          setI(L_I),
          ...readDigits(2, L_HOUR),
          ...expectChar(C_COLON),
          ...readDigits(2, L_MIN),
          // optional :ss
          ...peekIs(C_COLON),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              getI(L_I),
              i32c(1),
              { op: "i32.add" } as Instr,
              setI(L_I),
              ...readDigits(2, L_SEC),
              // optional .sss (read exactly 3 digits)
              ...peekIs(C_DOT),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I), ...readDigits(3, L_MS)],
              } as Instr,
            ],
          } as Instr,
          // optional timezone: Z | ±HH:mm
          ...peekIs(C_Z),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I)],
            else: [
              ...peekIs(C_PLUS),
              ...peekIs(C_MINUS),
              { op: "i32.or" } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // sign
                  ...peekIs(C_MINUS),
                  {
                    op: "if",
                    blockType: { kind: "val", type: i64 },
                    then: [i64c(-1n)],
                    else: [i64c(1n)],
                  } as Instr,
                  setI(L_TZSIGN),
                  getI(L_I),
                  i32c(1),
                  { op: "i32.add" } as Instr,
                  setI(L_I),
                  ...readDigits(2, L_TZH),
                  ...expectChar(C_COLON),
                  ...readDigits(2, L_TZM),
                ],
              } as Instr,
            ],
          } as Instr,
        ],
      } as Instr,
    ]),
  );

  // --- require we consumed the whole string (i == len) ---
  body.push(
    ...guarded([
      getI(L_I),
      getI(L_LEN),
      { op: "i32.ne" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [i32c(1), setI(L_FAIL)],
      } as Instr,
    ]),
  );

  // --- range validation (month 1-12, day 1-31, hour 0-24, min/sec 0-59, ms 0-999) ---
  const rangeFail = (l: number, lo: bigint, hi: bigint): Instr[] => [
    getI(l),
    i64c(lo),
    { op: "i64.lt_s" } as Instr,
    getI(l),
    i64c(hi),
    { op: "i64.gt_s" } as Instr,
    { op: "i32.or" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: [i32c(1), setI(L_FAIL)] } as Instr,
  ];
  body.push(
    ...guarded([
      ...rangeFail(L_MONTH, 1n, 12n),
      ...rangeFail(L_DAY, 1n, 31n),
      ...rangeFail(L_HOUR, 0n, 24n),
      ...rangeFail(L_MIN, 0n, 59n),
      ...rangeFail(L_SEC, 0n, 59n),
      ...rangeFail(L_TZH, 0n, 23n),
      ...rangeFail(L_TZM, 0n, 59n),
    ]),
  );

  // --- compose: ms = (daysFromCivil(y,m,d)*86400000) + h*3600000 + m*60000 +
  //                    s*1000 + ms  - tzOffsetMs ; return NaN if fail ---
  body.push(getI(L_FAIL), {
    op: "if",
    blockType: { kind: "val", type: f64 },
    then: [{ op: "f64.const", value: NaN } as Instr],
    else: [
      getI(L_YEAR),
      getI(L_MONTH),
      getI(L_DAY),
      { op: "call", funcIdx: daysFromCivilIdx } as Instr,
      setI(L_DAYS),
      getI(L_DAYS),
      i64c(86400000n),
      { op: "i64.mul" } as Instr,
      getI(L_HOUR),
      i64c(3600000n),
      { op: "i64.mul" } as Instr,
      { op: "i64.add" } as Instr,
      getI(L_MIN),
      i64c(60000n),
      { op: "i64.mul" } as Instr,
      { op: "i64.add" } as Instr,
      getI(L_SEC),
      i64c(1000n),
      { op: "i64.mul" } as Instr,
      { op: "i64.add" } as Instr,
      getI(L_MS),
      { op: "i64.add" } as Instr,
      // subtract timezone offset: tzSign * (tzH*3600000 + tzM*60000)
      getI(L_TZSIGN),
      getI(L_TZH),
      i64c(3600000n),
      { op: "i64.mul" } as Instr,
      getI(L_TZM),
      i64c(60000n),
      { op: "i64.mul" } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.mul" } as Instr,
      { op: "i64.sub" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    ],
  } as Instr);

  ctx.mod.functions.push({
    typeIdx,
    name: "__date_parse",
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
      { name: "len", type: i32 },
      { name: "i", type: i32 },
      { name: "c", type: i32 },
      { name: "sign", type: i64 },
      { name: "year", type: i64 },
      { name: "month", type: i64 },
      { name: "day", type: i64 },
      { name: "hour", type: i64 },
      { name: "min", type: i64 },
      { name: "sec", type: i64 },
      { name: "ms", type: i64 },
      { name: "tzSign", type: i64 },
      { name: "tzH", type: i64 },
      { name: "tzM", type: i64 },
      { name: "fail", type: i32 },
      { name: "acc", type: i64 },
      { name: "ndig", type: i32 },
      { name: "days", type: i64 },
      { name: "hasTime", type: i32 },
    ],
    body,
    exported: false,
  });
}
