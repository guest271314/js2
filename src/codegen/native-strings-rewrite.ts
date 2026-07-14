// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helper builders — replacement, split, construction & escape (#3182 Wave B, slice 1).
 *
 * Extracted verbatim from the tail of `ensureNativeStringHelpers` in
 * `native-strings.ts` (which had grown to ~4.8k LOC). This module emits
 * the rewriting/producing methods: `$`-pattern substitution
 * (`__str_getSubstitution`), `replace`/`replaceAll`, `split`, code-point
 * construction (`fromCodePoint`, `fromCharCode`) and `__regex_escape`.
 *
 * Each builder takes the shared per-call state ({@link NativeStrShared}) and is
 * called, in the original order, from `ensureNativeStringHelpers` AFTER the
 * core helpers (`__str_flatten`, `__str_concat`, `__str_equals`,
 * `__str_substring`, …) are registered — the builders look those up by name in
 * `ctx.nativeStrHelpers`.
 *
 * This is a pure mechanical relocation: the emitted Wasm bytes are byte-identical
 * to the pre-split inline blocks (verified via `prove-emit-identity`).
 */
import type { Instr, ValType } from "../ir/types.js";
import { addFuncType, getOrRegisterArrayType, getOrRegisterVecType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { NativeStrShared } from "./native-strings-shared.js";

/**
 * Replacement methods: the `$`-pattern `__str_getSubstitution` helper plus
 * `replace` and `replaceAll`.
 */
export function emitStrReplaceHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, anyStrTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;

  // --- $__str_getSubstitution(replacement, matched, prefix, suffix) -> ref $NativeString ---
  // #1822 — expand `$` patterns in a replacement string per ECMAScript
  // §22.1.3.19 GetSubstitution (string-search variant, no capture groups):
  //   $$ → "$"   $& → matched   $` → prefix (text before match)   $' → suffix
  // Any other `$X` (including `$1`..`$9` with no captures) is left literal.
  // Implementation: scan char-by-char, flushing literal runs via substring+concat
  // and inserting the expansion when a recognised pattern is found.
  {
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;

    const typeIdx = addFuncType(ctx, [strRef, strRef, strRef, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_getSubstitution", funcIdx);

    // params: replacement(0), matched(1), prefix(2), suffix(3)
    // locals: result(4), len(5), data(6), off(7), i(8), segStart(9), ch(10), next(11)
    const RES = 4;
    const LEN = 5;
    const DATA = 6;
    const OFF = 7;
    const I = 8;
    const SEG = 9;
    const CH = 10;
    const NEXT = 11;

    // Helper: result = concat(result, replacement.substring(SEG, I))
    const flushSegment = (): Instr[] => [
      { op: "local.get", index: RES },
      { op: "ref.as_non_null" },
      // replacement.substring(SEG, I)
      { op: "local.get", index: 0 },
      { op: "local.get", index: SEG },
      { op: "local.get", index: I },
      { op: "call", funcIdx: substringIdx },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: concatIdx },
      { op: "local.set", index: RES },
    ];
    // Helper: result = concat(result, <expansion local index>)
    const appendStr = (srcLocal: number): Instr[] => [
      { op: "local.get", index: RES },
      { op: "ref.as_non_null" },
      { op: "local.get", index: srcLocal },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: concatIdx },
      { op: "local.set", index: RES },
    ];
    // Advance both SEG and I past the 2-char `$X` token.
    const skipTwo: Instr[] = [
      { op: "local.get", index: I },
      { op: "i32.const", value: 2 },
      { op: "i32.add" },
      { op: "local.set", index: SEG },
      { op: "local.get", index: SEG },
      { op: "local.set", index: I },
    ];
    // A recognised `$X` case: flush the literal run [SEG,i), append the
    // expansion, then skip the 2-char token.
    const matchedCase = (appendBody: Instr[]): Instr[] => [...flushSegment(), ...appendBody, ...skipTwo];
    // The literal `$` for `$$` is replacement.substring(i, i+1).
    const appendDollarLiteral: Instr[] = [
      { op: "local.get", index: RES },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 0 },
      { op: "local.get", index: I },
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "call", funcIdx: substringIdx },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: concatIdx },
      { op: "local.set", index: RES },
    ];
    // Dispatch on the char after `$` (already known to exist). Chains
    // next==36 ($$) / 38 ($&) / 96 ($`) / 39 ($') / else literal-advance-1.
    const dollarDispatch = (): Instr[] => {
      const eqCase = (code: number, appendBody: Instr[], elseBody: Instr[]): Instr[] => [
        { op: "local.get", index: NEXT },
        { op: "i32.const", value: code },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: matchedCase(appendBody),
          else: elseBody,
        },
      ];
      // unrecognised $X: literal, advance 1
      const literalAdvance: Instr[] = [
        { op: "local.get", index: I },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: I },
      ];
      return [
        // next = data[off + i + 1]
        { op: "local.get", index: DATA },
        { op: "local.get", index: OFF },
        { op: "local.get", index: I },
        { op: "i32.add" },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx },
        { op: "local.set", index: NEXT },
        ...eqCase(
          36, // $$ → literal '$'
          appendDollarLiteral,
          eqCase(
            38, // $& → matched
            appendStr(1),
            eqCase(
              96, // $` → prefix
              appendStr(2),
              eqCase(39 /* $' → suffix */, appendStr(3), literalAdvance),
            ),
          ),
        ),
      ];
    };

    const body: Instr[] = [
      // result = "" (empty NativeString: len=0, off=0, empty data)
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
      { op: "struct.new", typeIdx: strTypeIdx },
      { op: "local.set", index: RES },

      // len = replacement.len ; data = replacement.data ; off = replacement.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: DATA },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: OFF },

      // i = 0 ; segStart = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: SEG },

      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break
              { op: "local.get", index: I },
              { op: "local.get", index: LEN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },

              // ch = data[off + i]
              { op: "local.get", index: DATA },
              { op: "local.get", index: OFF },
              { op: "local.get", index: I },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx },
              { op: "local.set", index: CH },

              // if ch == '$' (36) AND i+1 < len: inspect next char
              { op: "local.get", index: CH },
              { op: "i32.const", value: 36 },
              { op: "i32.eq" },
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: LEN },
              { op: "i32.lt_s" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: dollarDispatch(),
                else: [
                  // ch != '$' or at last char: advance 1 (literal)
                  { op: "local.get", index: I },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: I },
                ],
              },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // Flush trailing segment [SEG, len)
      { op: "local.get", index: RES },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 0 },
      { op: "local.get", index: SEG },
      { op: "local.get", index: LEN },
      { op: "call", funcIdx: substringIdx },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: concatIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_getSubstitution",
      typeIdx,
      locals: [
        { name: "result", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "len", type: { kind: "i32" } },
        { name: "data", type: strDataRef },
        { name: "off", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "segStart", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "next", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1, 2, 3]),
      exported: false,
    });
  }

  // --- $__str_replace(s: ref $NativeString, search: ref $NativeString, replacement: ref $NativeString) -> ref $NativeString ---
  // Replaces first occurrence of search with replacement. Pure wasm using indexOf + substring + concat.
  {
    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const getSubstitutionIdx = ctx.nativeStrHelpers.get("__str_getSubstitution")!;

    const typeIdx = addFuncType(ctx, [strRef, strRef, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_replace", funcIdx);

    // params: s(0), search(1), replacement(2)
    // locals: idx(3), searchLen(4), prefix(5-nullable), suffix(6-nullable)
    const body: Instr[] = [
      // idx = indexOf(s, search, 0)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: indexOfIdx },
      { op: "local.set", index: 3 },

      // if idx == -1, return s unchanged
      { op: "local.get", index: 3 },
      { op: "i32.const", value: -1 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [{ op: "local.get", index: 0 }],
        else: [
          // searchLen = search.len
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 4 },

          // prefix = s.substring(0, idx)
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 3 },
          { op: "call", funcIdx: substringIdx },
          { op: "local.set", index: 5 },

          // suffix = s.substring(idx + searchLen, MAX)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 4 },
          { op: "i32.add" },
          { op: "i32.const", value: 0x7fffffff },
          { op: "call", funcIdx: substringIdx },
          { op: "local.set", index: 6 },

          // #1822 — expand `$` patterns in the replacement before splicing:
          // return concat(concat(prefix, getSubstitution(replacement, search, prefix, suffix)), suffix)
          { op: "local.get", index: 5 },
          { op: "ref.as_non_null" },
          // getSubstitution(replacement=2, matched=search=1, prefix=5, suffix=6)
          { op: "local.get", index: 2 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 5 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 6 },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: getSubstitutionIdx },
          { op: "call", funcIdx: concatIdx },
          { op: "local.get", index: 6 },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: concatIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_replace",
      typeIdx,
      locals: [
        { name: "idx", type: { kind: "i32" } },
        { name: "searchLen", type: { kind: "i32" } },
        { name: "prefix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "suffix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1, 2]),
      exported: false,
    });
  }

  // --- $__str_replaceAll(s: ref $NativeString, search: ref $NativeString, replacement: ref $NativeString) -> ref $NativeString ---
  // Replaces ALL occurrences of search with replacement. Pure wasm loop using indexOf + substring + concat.
  {
    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const getSubstitutionIdx = ctx.nativeStrHelpers.get("__str_getSubstitution")!;

    const typeIdx = addFuncType(ctx, [strRef, strRef, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_replaceAll", funcIdx);

    // params: s(0), search(1), replacement(2)
    // locals: result(3-nullable), pos(4), idx(5), searchLen(6), prefix(7-nullable)
    const body: Instr[] = [
      // searchLen = search.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 6 },

      // #1822 — empty search: ECMAScript inserts the replacement before every
      // code unit AND at the end: "ab".replaceAll("","-") → "-a-b-".
      // (replacement has no $-expansion to do here: matched is "", and per the
      // string-search GetSubstitution prefix/suffix only matter for $`/$', which
      // for an empty-match position resolve to s[0..i] / s[i..]; but the common
      // case is a literal replacement, and expanding here would require per-pos
      // substitution. We interleave the literal replacement, matching V8/spec for
      // replacements without $ patterns — the dominant case for empty search.)
      { op: "local.get", index: 6 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // sLen = s.len  (reuse local 4 as i, local 5 as sLen)
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 5 },
          // result = replacement (a copy via concat with empty would be simplest;
          // start result = "" then prepend replacement in the loop pattern).
          // Build: result = replacement
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: concatIdx }, // "" + replacement
          { op: "local.set", index: 3 },
          // i = 0
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 4 },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // if i >= sLen break
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 5 },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  // result = concat(concat(result, s.substring(i,i+1)), replacement)
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 4 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "call", funcIdx: substringIdx },
                  { op: "ref.as_non_null" },
                  { op: "call", funcIdx: concatIdx },
                  { op: "local.get", index: 2 },
                  { op: "call", funcIdx: concatIdx },
                  { op: "local.set", index: 3 },
                  // i++
                  { op: "local.get", index: 4 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 4 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
        ],
        else: [
          // Build an empty result string (len=0, off=0, empty array)
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
          { op: "local.set", index: 3 },

          // pos = 0
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 4 },

          // loop: find next occurrence
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // idx = indexOf(s, search, pos)
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 1 },
                  { op: "local.get", index: 4 },
                  { op: "call", funcIdx: indexOfIdx },
                  { op: "local.set", index: 5 },

                  // if idx == -1, break
                  { op: "local.get", index: 5 },
                  { op: "i32.const", value: -1 },
                  { op: "i32.eq" },
                  { op: "br_if", depth: 1 },

                  // prefix = s.substring(pos, idx)
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 5 },
                  { op: "call", funcIdx: substringIdx },
                  { op: "local.set", index: 7 },

                  // result = concat(result, prefix)
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 7 },
                  { op: "ref.as_non_null" },
                  { op: "call", funcIdx: concatIdx },

                  // #1822 — result = concat(result, getSubstitution(replacement,
                  //   matched=search, prefix=s.substring(0,idx), suffix=s.substring(idx+searchLen)))
                  // GetSubstitution's `$\`` / `$'` use the FULL surrounding text,
                  // not just the inter-match slice.
                  { op: "local.get", index: 2 }, // replacement
                  { op: "local.get", index: 1 }, // matched = search
                  // fullPrefix = s.substring(0, idx)
                  { op: "local.get", index: 0 },
                  { op: "i32.const", value: 0 },
                  { op: "local.get", index: 5 },
                  { op: "call", funcIdx: substringIdx },
                  { op: "ref.as_non_null" },
                  // fullSuffix = s.substring(idx + searchLen, MAX)
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 6 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x7fffffff },
                  { op: "call", funcIdx: substringIdx },
                  { op: "ref.as_non_null" },
                  { op: "call", funcIdx: getSubstitutionIdx },
                  { op: "call", funcIdx: concatIdx },
                  { op: "local.set", index: 3 },

                  // pos = idx + searchLen
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 6 },
                  { op: "i32.add" },
                  { op: "local.set", index: 4 },

                  // continue loop
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },

          // Append remainder: result = concat(result, s.substring(pos, MAX))
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 4 },
          { op: "i32.const", value: 0x7fffffff },
          { op: "call", funcIdx: substringIdx },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: concatIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_replaceAll",
      typeIdx,
      locals: [
        { name: "result", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "pos", type: { kind: "i32" } },
        { name: "idx", type: { kind: "i32" } },
        { name: "searchLen", type: { kind: "i32" } },
        { name: "prefix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1, 2]),
      exported: false,
    });
  }
}

/**
 * `String.prototype.split` — returns a `$vec_nstr` of NativeStrings.
 */
export function emitStrSplitHelper(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, anyStrTypeIdx, strRef, wrapBodyWithFlatten } = shared;

  // --- $__str_split(s: ref $NativeString, sep: ref $NativeString, limit: i32) -> ref $vec_nstr ---
  // Splits s by sep, returns a native array of native strings. `limit` caps the
  // number of pieces (ECMA-262 §22.1.3.23): callers pass 0xFFFFFFFF (= -1 as i32)
  // for "no limit"; `limit === 0` yields the empty array (#2125).
  {
    // Register native string array type: (array (mut (ref null $AnyString)))
    // Use ref_null so array.new_default can initialize with null.
    // Key must match what resolveWasmType generates for string[] (ref_N).
    const nstrElemKey = `ref_${anyStrTypeIdx}`;
    const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
    const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
    const nstrVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);
    const nstrVecRef: ValType = { kind: "ref", typeIdx: nstrVecTypeIdx };

    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [nstrVecRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_split", funcIdx);

    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0), sep(1), limit(2)
    // locals: sLen(3), sepLen(4), pos(5), idx(6), part(7-nullable),
    //         resultArr(8-nullable), resultLen(9), resultCap(10), newArr(11-nullable)
    const S = 0,
      SEP = 1,
      LIMIT = 2;
    const SLEN = 3,
      SEPLEN = 4,
      POS = 5,
      IDX = 6,
      PART = 7;
    const RARR = 8,
      RLEN = 9,
      RCAP = 10,
      NEWARR = 11;

    const body: Instr[] = [
      // #2125: limit === 0 → return empty array (ECMA-262 §22.1.3.23 step 14).
      // The vec struct is { length: i32, data: ref $arr }, so push length 0
      // then a 0-capacity backing array.
      { op: "local.get", index: LIMIT },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 }, // vec length
          { op: "i32.const", value: 0 }, // backing array size
          { op: "array.new_default", typeIdx: nstrArrTypeIdx },
          { op: "struct.new", typeIdx: nstrVecTypeIdx },
          { op: "return" },
        ],
      },

      // sLen = s.len
      { op: "local.get", index: S },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: SLEN },

      // sepLen = sep.len
      { op: "local.get", index: SEP },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: SEPLEN },

      // resultArr = array.new_default(8)
      { op: "i32.const", value: 8 },
      { op: "array.new_default", typeIdx: nstrArrTypeIdx },
      { op: "local.set", index: RARR },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: RLEN },
      { op: "i32.const", value: 8 },
      { op: "local.set", index: RCAP },

      // pos = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: POS },

      // Handle empty separator: return array with single element (the whole string)
      { op: "local.get", index: SEPLEN },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // For empty sep, split each character (like JS)
          // But for simplicity and correctness, match JS: "abc".split("") => ["a","b","c"]
          // Realloc if needed for sLen elements
          { op: "local.get", index: SLEN },
          { op: "array.new_default", typeIdx: nstrArrTypeIdx },
          { op: "local.set", index: RARR },
          { op: "local.get", index: SLEN },
          { op: "local.set", index: RCAP },

          // Loop: for each character, create a single-char NativeString
          { op: "i32.const", value: 0 },
          { op: "local.set", index: POS },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // stop at sLen OR when we've emitted `limit` pieces (#2125)
                  { op: "local.get", index: POS },
                  { op: "local.get", index: SLEN },
                  { op: "i32.ge_s" },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: LIMIT },
                  { op: "i32.ge_u" },
                  { op: "i32.or" },
                  { op: "br_if", depth: 1 },

                  // part = substring(s, pos, pos+1)
                  { op: "local.get", index: S },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: POS },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "call", funcIdx: substringIdx },
                  { op: "local.set", index: PART },

                  // resultArr[pos] = part
                  { op: "local.get", index: RARR },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: PART },
                  { op: "array.set", typeIdx: nstrArrTypeIdx },

                  { op: "local.get", index: POS },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: POS },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },

          // return struct.new(pos, resultArr) — `pos` is the number of chars
          // actually emitted, which equals min(sLen, limit) (#2125).
          { op: "local.get", index: POS },
          { op: "local.get", index: RARR },
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: nstrVecTypeIdx },
          { op: "return" },
        ],
      },

      // Main split loop: find sep occurrences and extract substrings
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // #2125: stop once `limit` pieces have been collected. From the
              // loop body (not inside an `if`), depth 1 exits the wrapping block.
              { op: "local.get", index: RLEN },
              { op: "local.get", index: LIMIT },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 }, // break outer block

              // idx = indexOf(s, sep, pos)
              { op: "local.get", index: S },
              { op: "local.get", index: SEP },
              { op: "local.get", index: POS },
              { op: "call", funcIdx: indexOfIdx },
              { op: "local.set", index: IDX },

              // if idx == -1: add final part and break
              { op: "local.get", index: IDX },
              { op: "i32.const", value: -1 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // part = substring(s, pos, sLen)
                  { op: "local.get", index: S },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: SLEN },
                  { op: "call", funcIdx: substringIdx },
                  { op: "local.set", index: PART },

                  // Grow result if needed
                  { op: "local.get", index: RLEN },
                  { op: "local.get", index: RCAP },
                  { op: "i32.ge_s" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // newCap = cap * 2
                      { op: "local.get", index: RCAP },
                      { op: "i32.const", value: 2 },
                      { op: "i32.mul" },
                      { op: "local.set", index: RCAP },
                      // newArr = array.new_default(newCap)
                      { op: "local.get", index: RCAP },
                      { op: "array.new_default", typeIdx: nstrArrTypeIdx },
                      { op: "local.set", index: NEWARR },
                      // array.copy(newArr, 0, resultArr, 0, resultLen)
                      { op: "local.get", index: NEWARR },
                      { op: "i32.const", value: 0 },
                      { op: "local.get", index: RARR },
                      { op: "i32.const", value: 0 },
                      { op: "local.get", index: RLEN },
                      {
                        op: "array.copy",
                        dstTypeIdx: nstrArrTypeIdx,
                        srcTypeIdx: nstrArrTypeIdx,
                      },
                      { op: "local.get", index: NEWARR },
                      { op: "local.set", index: RARR },
                    ],
                  },

                  // resultArr[resultLen] = part
                  { op: "local.get", index: RARR },
                  { op: "local.get", index: RLEN },
                  { op: "local.get", index: PART },
                  { op: "array.set", typeIdx: nstrArrTypeIdx },
                  { op: "local.get", index: RLEN },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: RLEN },

                  { op: "br", depth: 2 }, // break outer block
                ],
              },

              // Found separator: part = substring(s, pos, idx)
              { op: "local.get", index: S },
              { op: "local.get", index: POS },
              { op: "local.get", index: IDX },
              { op: "call", funcIdx: substringIdx },
              { op: "local.set", index: PART },

              // Grow result if needed
              { op: "local.get", index: RLEN },
              { op: "local.get", index: RCAP },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: RCAP },
                  { op: "i32.const", value: 2 },
                  { op: "i32.mul" },
                  { op: "local.set", index: RCAP },
                  { op: "local.get", index: RCAP },
                  { op: "array.new_default", typeIdx: nstrArrTypeIdx },
                  { op: "local.set", index: NEWARR },
                  { op: "local.get", index: NEWARR },
                  { op: "i32.const", value: 0 },
                  { op: "local.get", index: RARR },
                  { op: "i32.const", value: 0 },
                  { op: "local.get", index: RLEN },
                  {
                    op: "array.copy",
                    dstTypeIdx: nstrArrTypeIdx,
                    srcTypeIdx: nstrArrTypeIdx,
                  },
                  { op: "local.get", index: NEWARR },
                  { op: "local.set", index: RARR },
                ],
              },

              // resultArr[resultLen] = part
              { op: "local.get", index: RARR },
              { op: "local.get", index: RLEN },
              { op: "local.get", index: PART },
              { op: "array.set", typeIdx: nstrArrTypeIdx },
              { op: "local.get", index: RLEN },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: RLEN },

              // pos = idx + sepLen
              { op: "local.get", index: IDX },
              { op: "local.get", index: SEPLEN },
              { op: "i32.add" },
              { op: "local.set", index: POS },

              { op: "br", depth: 0 }, // continue loop
            ],
          },
        ],
      },

      // return struct.new(resultLen, resultArr)
      { op: "local.get", index: RLEN },
      { op: "local.get", index: RARR },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: nstrVecTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_split",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "sepLen", type: { kind: "i32" } },
        { name: "pos", type: { kind: "i32" } },
        { name: "idx", type: { kind: "i32" } },
        { name: "part", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        {
          name: "resultArr",
          type: { kind: "ref_null", typeIdx: nstrArrTypeIdx },
        },
        { name: "resultLen", type: { kind: "i32" } },
        { name: "resultCap", type: { kind: "i32" } },
        { name: "newArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }
}

/**
 * String construction from code points: `fromCodePoint`, `fromCharCode`.
 */
export function emitStrConstructHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef } = shared;

  // --- $__str_fromCodePoint(cp: i32) -> ref $NativeString ---
  // Creates a NativeString from a Unicode code point.
  // BMP (cp <= 0xFFFF): 1-element array.
  // Supplementary (cp > 0xFFFF): 2-element surrogate pair.
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_fromCodePoint", funcIdx);

    // params: cp(0)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0xffff },
      { op: "i32.gt_u" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // Surrogate pair: len=2, off=0, [high, low]
          { op: "i32.const", value: 2 }, // len
          { op: "i32.const", value: 0 }, // off
          // high = ((cp - 0x10000) >> 10) + 0xD800
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0x10000 },
          { op: "i32.sub" },
          { op: "i32.const", value: 10 },
          { op: "i32.shr_u" },
          { op: "i32.const", value: 0xd800 },
          { op: "i32.add" },
          // low = ((cp - 0x10000) & 0x3FF) + 0xDC00
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0x10000 },
          { op: "i32.sub" },
          { op: "i32.const", value: 0x3ff },
          { op: "i32.and" },
          { op: "i32.const", value: 0xdc00 },
          { op: "i32.add" },
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 2 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // BMP: len=1, off=0, [cp]
          { op: "i32.const", value: 1 }, // len
          { op: "i32.const", value: 0 }, // off
          { op: "local.get", index: 0 }, // cp
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_fromCodePoint",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_fromCharCode(code: i32) -> ref $NativeString --- (#1598)
  // Creates a single-code-unit NativeString from a UTF-16 code unit. Per spec,
  // String.fromCharCode coerces each argument with ToUint16, so the low 16 bits
  // are taken (no surrogate-pair handling — that is fromCodePoint's job).
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_fromCharCode", funcIdx);

    // params: code(0). Build: struct.new $NativeString(len=1, off=0, [code & 0xFFFF])
    const body: Instr[] = [
      { op: "i32.const", value: 1 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "local.get", index: 0 }, // code
      { op: "i32.const", value: 0xffff },
      { op: "i32.and" }, // ToUint16
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_fromCharCode",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }
}

/**
 * `__regex_escape` (#2590) — escape RegExp metacharacters for `RegExp(str)`.
 */
export function emitStrRegexEscapeHelper(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef, flatStrRef, strDataRef, wrapBodyWithFlatten } = shared;

  // --- $__regex_escape(s: ref $AnyString) -> ref $AnyString --- (#2590)
  // Implements ES2025 RegExp.escape / EncodeForRegExpEscape: a pure string
  // transform that escapes regex-syntax-significant code points so the result
  // can be embedded safely in a pattern. No regex engine, no host import.
  //
  // Iterates the input's UTF-16 code units. For each code point c:
  //   - First code point only, if c ∈ [0-9A-Za-z] → "\xHH" (lowercase hex).
  //   - Syntax chars  ^ $ \ . * + ? ( ) [ ] { } |  and solidus /  → "\c".
  //   - ControlEscape  \t \n \v \f \r  (U+0009..U+000D)            → "\t" etc.
  //   - otherPunctuators / WhiteSpace / LineTerminator / lone surrogate:
  //        c ≤ 0xFF  → "\xHH"          (lowercase hex, 2 digits)
  //        else      → "\uHHHH"        (lowercase hex, 4 digits, per code unit)
  //   - Everything else → the code point's UTF-16 code units, unescaped.
  // A high+low surrogate pair forms a scalar code point > 0xFFFF that falls into
  // the final "unescaped" branch and is copied through; only *lone* surrogates
  // hit the \uHHHH branch.
  {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__regex_escape", funcIdx);

    // params: s(0)
    // locals: flat(1) ref $NativeString, data(2) ref $__str_data, off(3),
    //         len(4), i(5), out(6) ref $AnyString, cu(7), cu2(8), n0(9), n1(10)
    const FLAT = 1,
      DATA = 2,
      OFF = 3,
      LEN = 4,
      I = 5,
      OUT = 6,
      CU = 7,
      CU2 = 8,
      N0 = 9,
      N1 = 10;

    // nibble→ascii hex char (lowercase): d<10 ? d+0x30 : d+0x57
    const hexNibble = (load: Instr[]): Instr[] => [
      ...load,
      { op: "local.tee", index: N0 },
      { op: "i32.const", value: 10 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "local.get", index: N0 }, { op: "i32.const", value: 0x30 }, { op: "i32.add" }],
        else: [{ op: "local.get", index: N0 }, { op: "i32.const", value: 0x57 }, { op: "i32.add" }],
      },
    ];

    // Build "\uHHHH" flat $NativeString for code unit CU (6 code units).
    const uEscape: Instr[] = [
      { op: "i32.const", value: 6 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "i32.const", value: 0x5c }, // '\'
      { op: "i32.const", value: 0x75 }, // 'u'
      ...hexNibble([
        { op: "local.get", index: CU },
        { op: "i32.const", value: 12 },
        { op: "i32.shr_u" },
        { op: "i32.const", value: 0xf },
        { op: "i32.and" },
      ]),
      ...hexNibble([
        { op: "local.get", index: CU },
        { op: "i32.const", value: 8 },
        { op: "i32.shr_u" },
        { op: "i32.const", value: 0xf },
        { op: "i32.and" },
      ]),
      ...hexNibble([
        { op: "local.get", index: CU },
        { op: "i32.const", value: 4 },
        { op: "i32.shr_u" },
        { op: "i32.const", value: 0xf },
        { op: "i32.and" },
      ]),
      ...hexNibble([{ op: "local.get", index: CU }, { op: "i32.const", value: 0xf }, { op: "i32.and" }]),
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 6 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // Build "\xHH" flat $NativeString for code unit CU (4 code units).
    const xEscape: Instr[] = [
      { op: "i32.const", value: 4 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "i32.const", value: 0x5c }, // '\'
      { op: "i32.const", value: 0x78 }, // 'x'
      ...hexNibble([
        { op: "local.get", index: CU },
        { op: "i32.const", value: 4 },
        { op: "i32.shr_u" },
        { op: "i32.const", value: 0xf },
        { op: "i32.and" },
      ]),
      ...hexNibble([{ op: "local.get", index: CU }, { op: "i32.const", value: 0xf }, { op: "i32.and" }]),
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 4 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // Build "\<char>" (backslash + the code unit itself), 2 code units.
    const backslashEscape: Instr[] = [
      { op: "i32.const", value: 2 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "i32.const", value: 0x5c }, // '\'
      { op: "local.get", index: CU }, // the char
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // Build "\<ctrl>" where the named-escape letter is in N1, 2 code units.
    const namedCtrlEscape: Instr[] = [
      { op: "i32.const", value: 2 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "i32.const", value: 0x5c }, // '\'
      { op: "local.get", index: N1 }, // mapped letter t/n/v/f/r
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // Build a 1-code-unit flat string from CU (pass-through single).
    const oneUnit: Instr[] = [
      { op: "i32.const", value: 1 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "local.get", index: CU },
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // Build a 2-code-unit flat string from CU,CU2 (valid surrogate pair).
    const twoUnit: Instr[] = [
      { op: "i32.const", value: 2 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "local.get", index: CU },
      { op: "local.get", index: CU2 },
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // out = concat(out, piece); i += adv
    const emitAppend = (piece: Instr[], adv: number): Instr[] => [
      { op: "local.get", index: OUT },
      ...piece,
      { op: "call", funcIdx: concatIdx },
      { op: "local.set", index: OUT },
      { op: "local.get", index: I },
      { op: "i32.const", value: adv },
      { op: "i32.add" },
      { op: "local.set", index: I },
    ];

    // Is CU a syntax char or solidus? (^ $ \ . * + ? ( ) [ ] { } | /)
    const isSyntaxChar = (): Instr[] => {
      const codes = [0x5e, 0x24, 0x5c, 0x2e, 0x2a, 0x2b, 0x3f, 0x28, 0x29, 0x5b, 0x5d, 0x7b, 0x7d, 0x7c, 0x2f];
      const parts: Instr[] = [];
      codes.forEach((c, idx) => {
        parts.push({ op: "local.get", index: CU }, { op: "i32.const", value: c }, { op: "i32.eq" });
        if (idx > 0) parts.push({ op: "i32.or" });
      });
      return parts;
    };

    // Is CU in the "hex-escape" set? otherPunctuators ∪ WhiteSpace ∪
    // LineTerminator ∪ lone-surrogate (control 0x09..0x0D handled earlier).
    // otherPunctuators: , - = < > # & ! % : ; @ ~ ' ` "
    // WhiteSpace (Zs + special): 0x20 0xA0 0x1680 0x2000..0x200A 0x202F 0x205F 0x3000 0xFEFF
    // LineTerminator: 0x2028 0x2029  (0x0A/0x0D are control, handled earlier)
    // lone surrogate: 0xD800..0xDFFF
    const isHexEscapeChar = (): Instr[] => {
      const eqs = [
        0x2c,
        0x2d,
        0x3d,
        0x3c,
        0x3e,
        0x23,
        0x26,
        0x21,
        0x25,
        0x3a,
        0x3b,
        0x40,
        0x7e,
        0x27,
        0x60,
        0x22, // otherPunctuators
        0x20,
        0xa0,
        0x1680,
        0x202f,
        0x205f,
        0x3000,
        0xfeff, // WhiteSpace singletons
        0x2028,
        0x2029, // LineTerminator
      ];
      const parts: Instr[] = [];
      eqs.forEach((c) => {
        parts.push({ op: "local.get", index: CU }, { op: "i32.const", value: c }, { op: "i32.eq" });
      });
      // 0x2000..0x200A range (general punctuation spaces)
      parts.push(
        { op: "local.get", index: CU },
        { op: "i32.const", value: 0x2000 },
        { op: "i32.ge_u" },
        { op: "local.get", index: CU },
        { op: "i32.const", value: 0x200a },
        { op: "i32.le_u" },
        { op: "i32.and" },
      );
      // 0xD800..0xDFFF lone surrogate range
      parts.push(
        { op: "local.get", index: CU },
        { op: "i32.const", value: 0xd800 },
        { op: "i32.ge_u" },
        { op: "local.get", index: CU },
        { op: "i32.const", value: 0xdfff },
        { op: "i32.le_u" },
        { op: "i32.and" },
      );
      const total = eqs.length + 2; // singletons + 2 ranges
      for (let k = 1; k < total; k++) parts.push({ op: "i32.or" });
      return parts;
    };

    // Per-iteration body, executed while i < len.
    // The escape classification cascade (everything except the valid-surrogate-
    // pair passthrough). `cu` is already loaded. Wrapped in the `else` of the
    // pair check so a high surrogate forming a valid astral code point never
    // reaches the lone-surrogate `\uHHHH` branch (StringToCodePoints decodes a
    // valid pair into one >0xFFFF code point, which is in no escape set).
    const classifyBody: Instr[] = [
      // First code point && cu ∈ [0-9A-Za-z] → "\xHH"
      { op: "local.get", index: I },
      { op: "i32.eqz" },
      // digit 0x30..0x39
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x30 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x39 },
      { op: "i32.le_u" },
      { op: "i32.and" },
      // upper 0x41..0x5A
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x41 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x5a },
      { op: "i32.le_u" },
      { op: "i32.and" },
      { op: "i32.or" },
      // lower 0x61..0x7A
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x61 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x7a },
      { op: "i32.le_u" },
      { op: "i32.and" },
      { op: "i32.or" },
      { op: "i32.and" }, // && (i==0)
      {
        op: "if",
        blockType: { kind: "empty" },
        then: emitAppend(xEscape, 1),
        else: [
          // Syntax char / solidus → "\c"
          ...isSyntaxChar(),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: emitAppend(backslashEscape, 1),
            else: [
              // ControlEscape 0x09..0x0D → named \t \n \v \f \r
              { op: "local.get", index: CU },
              { op: "i32.const", value: 0x09 },
              { op: "i32.ge_u" },
              { op: "local.get", index: CU },
              { op: "i32.const", value: 0x0d },
              { op: "i32.le_u" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // N1 = letter: 0x09→t 0x0A→n 0x0B→v 0x0C→f 0x0D→r
                  { op: "local.get", index: CU },
                  { op: "i32.const", value: 0x09 },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [{ op: "i32.const", value: 0x74 }], // t
                    else: [
                      { op: "local.get", index: CU },
                      { op: "i32.const", value: 0x0a },
                      { op: "i32.eq" },
                      {
                        op: "if",
                        blockType: { kind: "val", type: { kind: "i32" } },
                        then: [{ op: "i32.const", value: 0x6e }], // n
                        else: [
                          { op: "local.get", index: CU },
                          { op: "i32.const", value: 0x0b },
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "val", type: { kind: "i32" } },
                            then: [{ op: "i32.const", value: 0x76 }], // v
                            else: [
                              { op: "local.get", index: CU },
                              { op: "i32.const", value: 0x0c },
                              { op: "i32.eq" },
                              {
                                op: "if",
                                blockType: { kind: "val", type: { kind: "i32" } },
                                then: [{ op: "i32.const", value: 0x66 }], // f
                                else: [{ op: "i32.const", value: 0x72 }], // r (0x0D)
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  { op: "local.set", index: N1 },
                  ...emitAppend(namedCtrlEscape, 1),
                ],
                else: [
                  // hex-escape set (otherPunctuators/WS/LT/lone surrogate)
                  ...isHexEscapeChar(),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // c ≤ 0xFF → \xHH ; else → \uHHHH
                      { op: "local.get", index: CU },
                      { op: "i32.const", value: 0xff },
                      { op: "i32.le_u" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: emitAppend(xEscape, 1),
                        else: emitAppend(uEscape, 1),
                      },
                    ],
                    // Unescaped single code unit. (Valid surrogate pairs are
                    // handled by the outer pair check; a lone surrogate matched
                    // the hex-escape branch above; so here cu is a plain BMP
                    // scalar or a lone surrogate that already routed to \uHHHH.)
                    else: emitAppend(oneUnit, 1),
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    // isValidPair = cu ∈ [0xD800,0xDBFF] && i+1 < len &&
    //               data[off+i+1] ∈ [0xDC00,0xDFFF]   (sets CU2 = next unit)
    const loopBody: Instr[] = [
      // cu = data[off + i]
      { op: "local.get", index: DATA },
      { op: "local.get", index: OFF },
      { op: "local.get", index: I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.set", index: CU },
      // high surrogate?
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xd800 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xdbff },
      { op: "i32.le_u" },
      { op: "i32.and" },
      // && i+1 < len
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.get", index: LEN },
      { op: "i32.lt_u" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // cu2 = data[off+i+1]; check it is a low surrogate
          { op: "local.get", index: DATA },
          { op: "local.get", index: OFF },
          { op: "local.get", index: I },
          { op: "i32.add" },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.tee", index: CU2 },
          { op: "i32.const", value: 0xdc00 },
          { op: "i32.ge_u" },
          { op: "local.get", index: CU2 },
          { op: "i32.const", value: 0xdfff },
          { op: "i32.le_u" },
          { op: "i32.and" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: emitAppend(twoUnit, 2), // valid astral pair → passthrough
        else: classifyBody,
      },
    ];

    const body: Instr[] = [
      // flat = flatten(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: FLAT },
      // data = flat.data ; off = flat.off ; len = flat.len
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: DATA },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: OFF },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      // out = "" (empty NativeString)
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "struct.new", typeIdx: strTypeIdx },
      { op: "local.set", index: OUT },
      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      // while (i < len) { loopBody }
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: I },
              { op: "local.get", index: LEN },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              ...loopBody,
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return out
      { op: "local.get", index: OUT },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__regex_escape",
      typeIdx,
      locals: [
        { name: "flat", type: flatStrRef },
        { name: "data", type: strDataRef },
        { name: "off", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "out", type: strRef },
        { name: "cu", type: { kind: "i32" } },
        { name: "cu2", type: { kind: "i32" } },
        { name: "n0", type: { kind: "i32" } },
        { name: "n1", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, []),
      exported: false,
    });
  }
}
