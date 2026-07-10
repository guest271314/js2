// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm legacy `escape` (§B.2.1.1) / `unescape` (§B.2.1.2) for
 * standalone / WASI targets (#3064, follow-up to #3063). In JS-host mode these
 * are `env.escape` / `env.unescape` imports; under `--target
 * standalone`/`--target wasi` there is no JS host, so the call site fell through
 * and returned `null` (~33 `annexB/built-ins/{escape,unescape}` test262 fail).
 * This module emits WasmGC-native implementations following the #679/#682
 * dual-backend pattern (mirrors `uri-encoding-native.ts` — but simpler: `escape`
 * / `unescape` operate on UTF-16 CODE UNITS, so there is no UTF-8 transcoding,
 * no surrogate pairing, and no error case).
 *
 * `escape(string)` (§B.2.1.1) — for each code unit `c`:
 *   - if `c` is in the unescaped set `A-Z a-z 0-9 @ * _ + - . /` → emit `c`;
 *   - else if `c ≥ 256` → emit six code units `%uWXYZ` (WXYZ = four uppercase
 *     hex digits of `c`);
 *   - else (`c < 256`) → emit three code units `%XY` (XY = two uppercase hex
 *     digits of `c`).
 *
 * `unescape(string)` (§B.2.1.2) — scanning index `k` over the input:
 *   - at a `%`:
 *       · if `k ≤ length-6`, unit `k+1` is `u`, and units `k+2..k+5` are all
 *         hex digits → the code unit from those four hex digits; advance 6;
 *       · else if `k ≤ length-3` and units `k+1,k+2` are both hex digits → the
 *         code unit from those two hex digits; advance 3;
 *       · else → the literal `%`; advance 1.
 *   - otherwise the code unit verbatim; advance 1.
 *   Hex digits are matched case-insensitively.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting

const i32: ValType = { kind: "i32" };

const get = (i: number): Instr => ({ op: "local.get", index: i }) as Instr;
const set = (i: number): Instr => ({ op: "local.set", index: i }) as Instr;
const c = (value: number): Instr => ({ op: "i32.const", value }) as Instr;

/**
 * Map a nibble (0..15) on the stack to its ASCII uppercase hex code unit,
 * computed purely on the stack: `v + (v<10 ? '0' : 'A'-10)` via `select`.
 * `select` pops (val1, val2, cond) and pushes val1 when cond!=0 else val2, so
 * the stack must be [val1='0', val2='A'-10, cond] at the select. Mirrors
 * `uri-encoding-native.ts`'s `hexDigit`.
 */
function hexDigit(vInstrs: Instr[]): Instr[] {
  return [
    ...vInstrs, // [v]
    c(48 /* '0' */),
    c(55 /* 'A'-10 */),
    ...vInstrs, // [v, 48, 55, v]
    c(10),
    { op: "i32.lt_u" } as Instr,
    { op: "select" } as Instr, // [v, base]
    { op: "i32.add" } as Instr, // [v + base]
  ];
}

/**
 * Emit the native `__escape(s: externref) -> externref` helper and register it
 * in `ctx.funcMap`. Idempotent. Must run after `ensureNativeStringHelpers` (it
 * calls it) so `__str_flatten` + the NativeString types exist, and before any
 * function body that calls it.
 */
export function emitNativeEscape(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__escape")) return;
  ensureNativeStringHelpers(ctx);

  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const realTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);

  // ── params ──
  const P_S = 0; // s: externref
  // ── locals ──
  const L_FLAT = 1; // flat: ref $NativeString
  const L_DATA = 2; // data: ref $i16arr
  const L_LEN = 3; // logical end index (off + len)
  const L_I = 4; // scan cursor
  const L_C = 5; // current code unit
  const L_OUT = 6; // out: ref $i16arr (over-allocated)
  const L_N = 7; // output length written so far

  // out[n++] = <value produced by chInstrs>
  const pushCh = (chInstrs: Instr[]): Instr[] => [
    get(L_OUT),
    get(L_N),
    ...chInstrs,
    { op: "array.set", typeIdx: strDataTypeIdx } as Instr,
    get(L_N),
    c(1),
    { op: "i32.add" } as Instr,
    set(L_N),
  ];

  // isUnescaped(L_C): A-Z a-z 0-9 @ * _ + - . /
  const eqC = (code: number): Instr[] => [get(L_C), c(code), { op: "i32.eq" } as Instr];
  const rangeC = (lo: number, hi: number): Instr[] => [
    get(L_C),
    c(lo),
    { op: "i32.ge_u" } as Instr,
    get(L_C),
    c(hi),
    { op: "i32.le_u" } as Instr,
    { op: "i32.and" } as Instr,
  ];
  const isUnescaped: Instr[] = [
    ...rangeC(0x41, 0x5a), // A-Z
    ...rangeC(0x61, 0x7a), // a-z
    { op: "i32.or" } as Instr,
    ...rangeC(0x30, 0x39), // 0-9
    { op: "i32.or" } as Instr,
    ...eqC(0x40), // @
    { op: "i32.or" } as Instr,
    ...eqC(0x2a), // *
    { op: "i32.or" } as Instr,
    ...eqC(0x5f), // _
    { op: "i32.or" } as Instr,
    ...eqC(0x2b), // +
    { op: "i32.or" } as Instr,
    ...eqC(0x2d), // -
    { op: "i32.or" } as Instr,
    ...eqC(0x2e), // .
    { op: "i32.or" } as Instr,
    ...eqC(0x2f), // /
    { op: "i32.or" } as Instr,
  ];

  const nibble = (shift: number): Instr[] => {
    const src = shift === 0 ? [get(L_C)] : [get(L_C), c(shift), { op: "i32.shr_u" } as Instr];
    return hexDigit([...src, c(0xf), { op: "i32.and" } as Instr]);
  };

  const body: Instr[] = [
    // flat = flatten(s); data = flat.data; i = flat.off; len = flat.off + flat.len
    get(P_S),
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
    { op: "call", funcIdx: flattenIdx } as Instr,
    { op: "ref.cast", typeIdx: strTypeIdx } as Instr,
    set(L_FLAT),
    get(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 } as Instr,
    set(L_DATA),
    get(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 } as Instr,
    set(L_I),
    // len = off + flat.len
    get(L_I),
    get(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 } as Instr,
    { op: "i32.add" } as Instr,
    set(L_LEN),
    // capacity = flat.len * 6 (worst case: code unit ≥ 256 → "%uWXYZ").
    get(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 } as Instr,
    c(6),
    { op: "i32.mul" } as Instr,
    { op: "array.new_default", typeIdx: strDataTypeIdx } as Instr,
    set(L_OUT),
    c(0),
    set(L_N),

    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= len break
            get(L_I),
            get(L_LEN),
            { op: "i32.ge_s" } as Instr,
            { op: "br_if", depth: 1 } as Instr,
            // c = data[i]
            get(L_DATA),
            get(L_I),
            { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
            set(L_C),
            ...isUnescaped,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...pushCh([get(L_C)])],
              else: [
                get(L_C),
                c(256),
                { op: "i32.ge_u" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // %uWXYZ
                    ...pushCh([c(37 /* % */)]),
                    ...pushCh([c(117 /* u */)]),
                    ...pushCh(nibble(12)),
                    ...pushCh(nibble(8)),
                    ...pushCh(nibble(4)),
                    ...pushCh(nibble(0)),
                  ],
                  else: [
                    // %XY
                    ...pushCh([c(37 /* % */)]),
                    ...pushCh(nibble(4)),
                    ...pushCh(nibble(0)),
                  ],
                } as Instr,
              ],
            } as Instr,
            // i++
            get(L_I),
            c(1),
            { op: "i32.add" } as Instr,
            set(L_I),
            { op: "br", depth: 0 } as Instr,
          ],
        },
      ],
    },

    // return struct.new $NativeString(len=n, off=0, data=out) widened to externref
    get(L_N),
    c(0),
    get(L_OUT),
    { op: "struct.new", typeIdx: strTypeIdx } as Instr,
    { op: "extern.convert_any" } as Instr,
  ];

  const idx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__escape", idx);
  pushDefinedFunc(ctx, idx, {
    name: "__escape",
    typeIdx: realTypeIdx,
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } }, // L_FLAT
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_DATA
      { name: "len", type: i32 }, // L_LEN
      { name: "i", type: i32 }, // L_I
      { name: "ch", type: i32 }, // L_C
      { name: "out", type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_OUT
      { name: "n", type: i32 }, // L_N
    ],
    body,
    exported: false,
  } as unknown as WasmFunction);
}

/**
 * Emit the native `__unescape(s: externref) -> externref` helper and register
 * it in `ctx.funcMap`. Idempotent. Same prerequisites as `emitNativeEscape`.
 */
export function emitNativeUnescape(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__unescape")) return;
  ensureNativeStringHelpers(ctx);

  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const realTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);

  // ── params ──
  const P_S = 0; // s: externref
  // ── locals ──
  const L_FLAT = 1; // flat: ref $NativeString
  const L_DATA = 2; // data: ref $i16arr
  const L_LEN = 3; // logical end index (off + len)
  const L_I = 4; // scan cursor
  const L_C = 5; // current / decoded code unit
  const L_OUT = 6; // out: ref $i16arr
  const L_N = 7; // output length written so far
  const L_CH = 8; // scratch: a code unit being hex-classified
  const L_N2 = 9; // decoded nibble / hex value
  const L_N3 = 10;
  const L_N4 = 11;
  const L_N5 = 12;
  const L_DONE = 13; // 1 once the `%`-escape has been decoded

  // out[n++] = L_C
  const pushC: Instr[] = [
    get(L_OUT),
    get(L_N),
    get(L_C),
    { op: "array.set", typeIdx: strDataTypeIdx } as Instr,
    get(L_N),
    c(1),
    { op: "i32.add" } as Instr,
    set(L_N),
  ];

  const idxPlus = (n: number): Instr[] => (n === 0 ? [get(L_I)] : [get(L_I), c(n), { op: "i32.add" } as Instr]);
  const readUnit = (n: number): Instr[] => [
    get(L_DATA),
    ...idxPlus(n),
    { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
  ];

  // Read data[<idxInstrs>] into L_CH, then push its hex value (0..15) or -1 when
  // not a hex digit, computed purely on the stack from L_CH:
  //   lc = ch | 0x20
  //   result = (0x30<=ch<=0x39) ? ch-0x30 : ((0x61<=lc<=0x66) ? lc-0x57 : -1)
  const nibbleOf = (idxInstrs: Instr[]): Instr[] => [
    get(L_DATA),
    ...idxInstrs,
    { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
    set(L_CH),
    // digit value candidate: ch - 0x30
    get(L_CH),
    c(0x30),
    { op: "i32.sub" } as Instr,
    // a-f value candidate: (ch|0x20) - 0x57
    get(L_CH),
    c(0x20),
    { op: "i32.or" } as Instr,
    c(0x57),
    { op: "i32.sub" } as Instr,
    c(-1),
    // afOk = (0x61 <= (ch|0x20) <= 0x66)
    get(L_CH),
    c(0x20),
    { op: "i32.or" } as Instr,
    c(0x61),
    { op: "i32.ge_u" } as Instr,
    get(L_CH),
    c(0x20),
    { op: "i32.or" } as Instr,
    c(0x66),
    { op: "i32.le_u" } as Instr,
    { op: "i32.and" } as Instr,
    { op: "select" } as Instr, // stack: [digitCand, (afOk ? afCand : -1)]
    // digitOk = (0x30 <= ch <= 0x39)
    get(L_CH),
    c(0x30),
    { op: "i32.ge_u" } as Instr,
    get(L_CH),
    c(0x39),
    { op: "i32.le_u" } as Instr,
    { op: "i32.and" } as Instr,
    { op: "select" } as Instr, // digitOk ? digitCand : (afOk ? afCand : -1)
  ];

  const body: Instr[] = [
    get(P_S),
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
    { op: "call", funcIdx: flattenIdx } as Instr,
    { op: "ref.cast", typeIdx: strTypeIdx } as Instr,
    set(L_FLAT),
    get(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 } as Instr,
    set(L_DATA),
    get(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 } as Instr,
    set(L_I),
    get(L_I),
    get(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 } as Instr,
    { op: "i32.add" } as Instr,
    set(L_LEN),
    // capacity = flat.len (output is never longer than input).
    get(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 } as Instr,
    { op: "array.new_default", typeIdx: strDataTypeIdx } as Instr,
    set(L_OUT),
    c(0),
    set(L_N),

    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(L_I),
            get(L_LEN),
            { op: "i32.ge_s" } as Instr,
            { op: "br_if", depth: 1 } as Instr,
            // c = data[i]
            ...readUnit(0),
            set(L_C),
            // if c == '%'
            get(L_C),
            c(0x25),
            { op: "i32.eq" } as Instr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                c(0),
                set(L_DONE),
                // %uWXYZ attempt — guard: i+5 < len (⟺ k ≤ length-6)
                get(L_I),
                c(5),
                { op: "i32.add" } as Instr,
                get(L_LEN),
                { op: "i32.lt_s" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // data[i+1] == 'u'
                    ...readUnit(1),
                    c(117 /* u */),
                    { op: "i32.eq" } as Instr,
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        ...nibbleOf(idxPlus(2)),
                        set(L_N2),
                        ...nibbleOf(idxPlus(3)),
                        set(L_N3),
                        ...nibbleOf(idxPlus(4)),
                        set(L_N4),
                        ...nibbleOf(idxPlus(5)),
                        set(L_N5),
                        // all four ≥ 0 ?
                        get(L_N2),
                        c(0),
                        { op: "i32.ge_s" } as Instr,
                        get(L_N3),
                        c(0),
                        { op: "i32.ge_s" } as Instr,
                        { op: "i32.and" } as Instr,
                        get(L_N4),
                        c(0),
                        { op: "i32.ge_s" } as Instr,
                        { op: "i32.and" } as Instr,
                        get(L_N5),
                        c(0),
                        { op: "i32.ge_s" } as Instr,
                        { op: "i32.and" } as Instr,
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            // c = (n2<<12)|(n3<<8)|(n4<<4)|n5
                            get(L_N2),
                            c(12),
                            { op: "i32.shl" } as Instr,
                            get(L_N3),
                            c(8),
                            { op: "i32.shl" } as Instr,
                            { op: "i32.or" } as Instr,
                            get(L_N4),
                            c(4),
                            { op: "i32.shl" } as Instr,
                            { op: "i32.or" } as Instr,
                            get(L_N5),
                            { op: "i32.or" } as Instr,
                            set(L_C),
                            get(L_I),
                            c(5),
                            { op: "i32.add" } as Instr,
                            set(L_I),
                            c(1),
                            set(L_DONE),
                          ],
                        } as Instr,
                      ],
                    } as Instr,
                  ],
                } as Instr,
                // %XY attempt (only if not already decoded) — guard: i+2 < len
                get(L_DONE),
                { op: "i32.eqz" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    get(L_I),
                    c(2),
                    { op: "i32.add" } as Instr,
                    get(L_LEN),
                    { op: "i32.lt_s" } as Instr,
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        ...nibbleOf(idxPlus(1)),
                        set(L_N2),
                        ...nibbleOf(idxPlus(2)),
                        set(L_N3),
                        get(L_N2),
                        c(0),
                        { op: "i32.ge_s" } as Instr,
                        get(L_N3),
                        c(0),
                        { op: "i32.ge_s" } as Instr,
                        { op: "i32.and" } as Instr,
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            get(L_N2),
                            c(4),
                            { op: "i32.shl" } as Instr,
                            get(L_N3),
                            { op: "i32.or" } as Instr,
                            set(L_C),
                            get(L_I),
                            c(2),
                            { op: "i32.add" } as Instr,
                            set(L_I),
                          ],
                        } as Instr,
                      ],
                    } as Instr,
                  ],
                } as Instr,
              ],
            } as Instr,
            // out[n++] = c ; i++
            ...pushC,
            get(L_I),
            c(1),
            { op: "i32.add" } as Instr,
            set(L_I),
            { op: "br", depth: 0 } as Instr,
          ],
        },
      ],
    },

    get(L_N),
    c(0),
    get(L_OUT),
    { op: "struct.new", typeIdx: strTypeIdx } as Instr,
    { op: "extern.convert_any" } as Instr,
  ];

  const idx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__unescape", idx);
  pushDefinedFunc(ctx, idx, {
    name: "__unescape",
    typeIdx: realTypeIdx,
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } }, // L_FLAT
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_DATA
      { name: "len", type: i32 }, // L_LEN
      { name: "i", type: i32 }, // L_I
      { name: "ch", type: i32 }, // L_C
      { name: "out", type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_OUT
      { name: "n", type: i32 }, // L_N
      { name: "scratch", type: i32 }, // L_CH
      { name: "n2", type: i32 }, // L_N2
      { name: "n3", type: i32 }, // L_N3
      { name: "n4", type: i32 }, // L_N4
      { name: "n5", type: i32 }, // L_N5
      { name: "done", type: i32 }, // L_DONE
    ],
    body,
    exported: false,
  } as unknown as WasmFunction);
}
