// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm `encodeURI` / `encodeURIComponent` for standalone / WASI targets
 * (#2500). In JS-host mode these are `env.*` imports; under `--target
 * wasi`/`--target standalone` there is no JS host, so the call sites silently
 * fell through to a `ref.test`/`ref.cast` of the argument and returned `null`
 * (~133 `built-ins/{encodeURI,encodeURIComponent,…}` test262 fail). This module
 * emits a WasmGC-native implementation following the #679/#682 dual-backend
 * pattern (mirrors `parse-number-native.ts` / `case-convert-native.ts`).
 *
 * Spec — ECMAScript §19.2.6.5 Encode( _string_, _unescapedSet_ ):
 *   For each code point of the input UTF-16 string:
 *     - if its single code unit is in _unescapedSet_, emit it verbatim;
 *     - otherwise UTF-8-encode the code point (RFC 3629, 1–4 octets) and emit
 *       `%XX` (uppercase hex) per octet. An unpaired surrogate → **URIError**.
 *
 *   `encodeURIComponent` _unescapedSet_ (`uriUnescaped`):
 *       A-Z a-z 0-9 - _ . ! ~ * ' ( )
 *   `encodeURI` _unescapedSet_ = `uriUnescaped` ∪ `uriReserved` ∪ `#`, adding:
 *       ; / ? : @ & = + $ , #
 *
 * The two variants are selected by `preservedMask`:
 *   bit 0 (always set) → include `uriUnescaped`
 *   bit 1             → also include `uriReserved` ∪ `#` (the encodeURI extras)
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers, stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addFuncType } from "./registry/types.js";

/** Helper-name -> mask routed at the call site (calls.ts). */
export const URI_ENCODE_MASK: Record<string, number> = {
  encodeURIComponent: 0b01,
  encodeURI: 0b11,
};

/**
 * Emit the native `__uri_encode(s: externref, preservedMask: i32) -> externref`
 * helper and register it in `ctx.funcMap`. Idempotent. Must run after
 * `ensureNativeStringHelpers` (it calls it) so `__str_flatten` and the
 * NativeString types exist, and before any function body that calls it.
 */
export function emitNativeUriEncode(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__uri_encode")) return;
  ensureNativeStringHelpers(ctx);

  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const extern: ValType = { kind: "externref" };

  // Register the URIError constructor + the function type BEFORE computing
  // `__uri_encode`'s funcIdx — `emitWasiErrorConstructor` appends `__new_URIError`
  // to `ctx.mod.functions`, which would shift our slot. Compute funcIdx and set
  // the funcMap entry only right before the push (see end of function), once no
  // more dependency functions can be appended ahead of us.
  emitWasiErrorConstructor(ctx, "URIError", 1);
  addStringConstantGlobal(ctx, "URI malformed");
  const uriErrCtorIdx = ctx.funcMap.get("__new_URIError")!;
  const tagIdx = ensureExnTag(ctx);
  // (externref, i32) -> externref  (the result string ref is widened to externref)
  const realTypeIdx = addFuncType(ctx, [extern, i32], [extern]);

  // ── params ──
  const P_S = 0; // s: externref
  const P_MASK = 1; // preservedMask: i32
  // ── locals ──
  const L_FLAT = 2; // flat: ref $NativeString
  const L_DATA = 3; // data: ref $i16arr
  const L_LEN = 4; // logical end index (off + len)
  const L_I = 5; // scan cursor
  const L_C = 6; // current code unit
  const L_CP = 7; // decoded code point
  const L_OUT = 8; // out: ref $i16arr (over-allocated)
  const L_N = 9; // output length written so far
  const L_B = 10; // a single UTF-8 byte
  const L_LO = 11; // low surrogate
  const L_CAP = 12; // out capacity

  const get = (i: number): Instr => ({ op: "local.get", index: i }) as Instr;
  const set = (i: number): Instr => ({ op: "local.set", index: i }) as Instr;
  const tee = (i: number): Instr => ({ op: "local.tee", index: i }) as Instr;
  const c = (value: number): Instr => ({ op: "i32.const", value }) as Instr;

  // out[n++] = ch  (ch already on stack-free; pass via instrs producing the value)
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

  // hexDigit(nibble 0..15) -> ASCII uppercase hex code unit, computed purely on
  // the stack (no scratch local, so it never clobbers L_B): the nibble value `v`
  // is mapped via `v + (v<10 ? '0' : 'A'-10)` using `select`. Both branch
  // operands are constants, so no value-stack juggling is needed.
  //   stack: [v] -> [hexCodeUnit]
  const hexDigit = (vInstrs: Instr[]): Instr[] => {
    // result = v + select('0', 'A'-10, v<10).
    // select pops (cond, val2, val1) and pushes val1 when cond!=0 else val2, so
    // the stack must be [val1='0', val2='A'-10, cond] at the select.
    return [
      ...vInstrs, // [v]              (addend lhs for the final i32.add)
      c(48 /* '0' */), // [v, 48]
      c(55 /* 'A'-10 */), // [v, 48, 55]
      ...vInstrs, // [v, 48, 55, v]
      c(10),
      { op: "i32.lt_u" } as Instr, // [v, 48, 55, (v<10)]
      { op: "select" } as Instr, // [v, base]
      { op: "i32.add" } as Instr, // [v + base]
    ];
  };

  // Emit one byte (in L_B) as %XX (uppercase). Consumes nothing; reads L_B.
  const emitPercentByte: Instr[] = [
    ...pushCh([c(37 /* '%' */)]),
    ...pushCh(hexDigit([get(L_B), c(4), { op: "i32.shr_u" } as Instr, c(0xf), { op: "i32.and" } as Instr])),
    ...pushCh(hexDigit([get(L_B), c(0xf), { op: "i32.and" } as Instr])),
  ];

  // isPreserved(c, mask): leaves i32 bool. Reads L_C and P_MASK.
  // uriUnescaped: A-Z a-z 0-9 - _ . ! ~ * ' ( )
  //   codes: 0x2D(-) 0x5F(_) 0x2E(.) 0x21(!) 0x7E(~) 0x2A(*) 0x27(') 0x28(() 0x29())
  // uriReserved ∪ #: ; / ? : @ & = + $ , #
  //   codes: 0x3B(;) 0x2F(/) 0x3F(?) 0x3A(:) 0x40(@) 0x26(&) 0x3D(=) 0x2B(+) 0x24($) 0x2C(,) 0x23(#)
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
  const isPreserved: Instr[] = [
    // alphanumerics
    ...rangeC(0x41, 0x5a), // A-Z
    ...rangeC(0x61, 0x7a), // a-z
    { op: "i32.or" } as Instr,
    ...rangeC(0x30, 0x39), // 0-9
    { op: "i32.or" } as Instr,
    // uriUnescaped marks
    ...eqC(0x2d),
    { op: "i32.or" } as Instr,
    ...eqC(0x5f),
    { op: "i32.or" } as Instr,
    ...eqC(0x2e),
    { op: "i32.or" } as Instr,
    ...eqC(0x21),
    { op: "i32.or" } as Instr,
    ...eqC(0x7e),
    { op: "i32.or" } as Instr,
    ...eqC(0x2a),
    { op: "i32.or" } as Instr,
    ...eqC(0x27),
    { op: "i32.or" } as Instr,
    ...eqC(0x28),
    { op: "i32.or" } as Instr,
    ...eqC(0x29),
    { op: "i32.or" } as Instr,
    // encodeURI extras gated by mask bit 1
    get(P_MASK),
    c(0b10),
    { op: "i32.and" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        ...eqC(0x3b),
        ...eqC(0x2f),
        { op: "i32.or" } as Instr,
        ...eqC(0x3f),
        { op: "i32.or" } as Instr,
        ...eqC(0x3a),
        { op: "i32.or" } as Instr,
        ...eqC(0x40),
        { op: "i32.or" } as Instr,
        ...eqC(0x26),
        { op: "i32.or" } as Instr,
        ...eqC(0x3d),
        { op: "i32.or" } as Instr,
        ...eqC(0x2b),
        { op: "i32.or" } as Instr,
        ...eqC(0x24),
        { op: "i32.or" } as Instr,
        ...eqC(0x2c),
        { op: "i32.or" } as Instr,
        ...eqC(0x23),
        { op: "i32.or" } as Instr,
      ],
      else: [c(0)],
    } as Instr,
    { op: "i32.or" } as Instr,
  ];

  // ── URIError throw sequence (raw Instrs) ──
  // (ctor + string constant + exn tag were registered up top so they don't shift
  // our funcIdx; reuse the captured `uriErrCtorIdx` / `tagIdx`.)
  const throwURIError: Instr[] = [
    ...stringConstantExternrefInstrs(ctx, "URI malformed"),
    { op: "call", funcIdx: uriErrCtorIdx } as Instr,
    { op: "throw", tagIdx } as Instr,
  ];

  // getC: L_C = data[L_I]
  const getC: Instr[] = [get(L_DATA), get(L_I), { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr, set(L_C)];

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
    // capacity = (len - off) * 9  (worst case: BMP char → 3 octets → 9 chars).
    // Guard a 0-length string (cap=0 array is valid; loop won't run).
    get(L_LEN),
    get(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 } as Instr,
    { op: "i32.sub" } as Instr,
    c(9),
    { op: "i32.mul" } as Instr,
    tee(L_CAP),
    { op: "array.new_default", typeIdx: strDataTypeIdx } as Instr,
    set(L_OUT),
    c(0),
    set(L_N),

    // main scan
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i>=len break
            get(L_I),
            get(L_LEN),
            { op: "i32.ge_s" } as Instr,
            { op: "br_if", depth: 1 } as Instr,
            ...getC,
            // if isPreserved(c): out[n++]=c; i++; continue
            ...isPreserved,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...pushCh([get(L_C)]),
                get(L_I),
                c(1),
                { op: "i32.add" } as Instr,
                set(L_I),
                { op: "br", depth: 1 } as Instr, // continue loop
              ],
            } as Instr,
            // ── not preserved: decode code point ──
            // default cp = c, advance 1
            get(L_C),
            set(L_CP),
            get(L_I),
            c(1),
            { op: "i32.add" } as Instr,
            set(L_I),
            // high surrogate? 0xD800..0xDBFF
            get(L_C),
            c(0xd800),
            { op: "i32.ge_u" } as Instr,
            get(L_C),
            c(0xdbff),
            { op: "i32.le_u" } as Instr,
            { op: "i32.and" } as Instr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // need a following low surrogate
                get(L_I),
                get(L_LEN),
                { op: "i32.ge_s" } as Instr,
                { op: "if", blockType: { kind: "empty" }, then: [...throwURIError] } as Instr,
                // lo = data[i]
                get(L_DATA),
                get(L_I),
                { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
                set(L_LO),
                // lo in 0xDC00..0xDFFF ?
                get(L_LO),
                c(0xdc00),
                { op: "i32.ge_u" } as Instr,
                get(L_LO),
                c(0xdfff),
                { op: "i32.le_u" } as Instr,
                { op: "i32.and" } as Instr,
                { op: "i32.eqz" } as Instr,
                { op: "if", blockType: { kind: "empty" }, then: [...throwURIError] } as Instr,
                // cp = 0x10000 + ((c-0xD800)<<10) + (lo-0xDC00)
                c(0x10000),
                get(L_C),
                c(0xd800),
                { op: "i32.sub" } as Instr,
                c(10),
                { op: "i32.shl" } as Instr,
                { op: "i32.add" } as Instr,
                get(L_LO),
                c(0xdc00),
                { op: "i32.sub" } as Instr,
                { op: "i32.add" } as Instr,
                set(L_CP),
                // consume the low surrogate
                get(L_I),
                c(1),
                { op: "i32.add" } as Instr,
                set(L_I),
              ],
            } as Instr,
            // lone low surrogate (0xDC00..0xDFFF) → URIError
            get(L_C),
            c(0xdc00),
            { op: "i32.ge_u" } as Instr,
            get(L_C),
            c(0xdfff),
            { op: "i32.le_u" } as Instr,
            { op: "i32.and" } as Instr,
            { op: "if", blockType: { kind: "empty" }, then: [...throwURIError] } as Instr,

            // ── UTF-8 encode cp into %XX bytes ──
            // nbytes = cp<=0x7F?1 : cp<=0x7FF?2 : cp<=0xFFFF?3 : 4
            get(L_CP),
            c(0x7f),
            { op: "i32.le_u" } as Instr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // 1 byte: cp
                get(L_CP),
                set(L_B),
                ...emitPercentByte,
              ],
              else: [
                get(L_CP),
                c(0x7ff),
                { op: "i32.le_u" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // 2 bytes: 110xxxxx 10xxxxxx
                    get(L_CP),
                    c(6),
                    { op: "i32.shr_u" } as Instr,
                    c(0xc0),
                    { op: "i32.or" } as Instr,
                    set(L_B),
                    ...emitPercentByte,
                    get(L_CP),
                    c(0x3f),
                    { op: "i32.and" } as Instr,
                    c(0x80),
                    { op: "i32.or" } as Instr,
                    set(L_B),
                    ...emitPercentByte,
                  ],
                  else: [
                    get(L_CP),
                    c(0xffff),
                    { op: "i32.le_u" } as Instr,
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        // 3 bytes: 1110xxxx 10xxxxxx 10xxxxxx
                        get(L_CP),
                        c(12),
                        { op: "i32.shr_u" } as Instr,
                        c(0xe0),
                        { op: "i32.or" } as Instr,
                        set(L_B),
                        ...emitPercentByte,
                        get(L_CP),
                        c(6),
                        { op: "i32.shr_u" } as Instr,
                        c(0x3f),
                        { op: "i32.and" } as Instr,
                        c(0x80),
                        { op: "i32.or" } as Instr,
                        set(L_B),
                        ...emitPercentByte,
                        get(L_CP),
                        c(0x3f),
                        { op: "i32.and" } as Instr,
                        c(0x80),
                        { op: "i32.or" } as Instr,
                        set(L_B),
                        ...emitPercentByte,
                      ],
                      else: [
                        // 4 bytes: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
                        get(L_CP),
                        c(18),
                        { op: "i32.shr_u" } as Instr,
                        c(0xf0),
                        { op: "i32.or" } as Instr,
                        set(L_B),
                        ...emitPercentByte,
                        get(L_CP),
                        c(12),
                        { op: "i32.shr_u" } as Instr,
                        c(0x3f),
                        { op: "i32.and" } as Instr,
                        c(0x80),
                        { op: "i32.or" } as Instr,
                        set(L_B),
                        ...emitPercentByte,
                        get(L_CP),
                        c(6),
                        { op: "i32.shr_u" } as Instr,
                        c(0x3f),
                        { op: "i32.and" } as Instr,
                        c(0x80),
                        { op: "i32.or" } as Instr,
                        set(L_B),
                        ...emitPercentByte,
                        get(L_CP),
                        c(0x3f),
                        { op: "i32.and" } as Instr,
                        c(0x80),
                        { op: "i32.or" } as Instr,
                        set(L_B),
                        ...emitPercentByte,
                      ],
                    } as Instr,
                  ],
                } as Instr,
              ],
            } as Instr,
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
  // Now that no further dependency functions can be appended ahead of us,
  // claim the slot: funcIdx = numImportFuncs + current functions length.
  ctx.funcMap.set("__uri_encode", ctx.numImportFuncs + ctx.mod.functions.length);

  ctx.mod.functions.push({
    name: "__uri_encode",
    typeIdx: realTypeIdx,
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } }, // L_FLAT
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_DATA
      { name: "len", type: i32 }, // L_LEN
      { name: "i", type: i32 }, // L_I
      { name: "ch", type: i32 }, // L_C
      { name: "cp", type: i32 }, // L_CP
      { name: "out", type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_OUT
      { name: "n", type: i32 }, // L_N
      { name: "b", type: i32 }, // L_B
      { name: "lo", type: i32 }, // L_LO
      { name: "cap", type: i32 }, // L_CAP
    ],
    body,
    exported: false,
  } as unknown as WasmFunction);
}
