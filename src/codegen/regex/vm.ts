// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — Reference backtracking VM (pure TypeScript).
 *
 * This is the executable specification for the Wasm interpreter
 * (`__regex_run` in `src/codegen/native-regex.ts`). The Wasm version mirrors
 * this control flow opcode-for-opcode, so unit tests can validate the
 * parse→compile→run pipeline without compiling any Wasm. Keeping the
 * algorithm here also documents exactly what the hand-authored Wasm must do.
 *
 * Algorithm: explicit-stack backtracking over the flat program. Each backtrack
 * entry is `(pc, sp, capsSnapshotMarker)`. To keep captures cheap we snapshot
 * the whole capture array on SPLIT (Phase 2a; a trail-based undo is a 2b
 * optimisation). A bounded step counter guards catastrophic backtracking.
 */
import { ReOp } from "./bytecode.js";

/** Matches the Wasm VM's step cap. Tunable; documented in the issue. */
export const REGEX_STEP_CAP = 1_000_000;

export interface VmMatch {
  /** Capture slots: `[g0start,g0end,g1start,g1end,…]`; -1 = unset. */
  caps: Int32Array;
}

interface Frame {
  pc: number;
  sp: number;
  caps: Int32Array;
}

/** Does code unit `c` fall in class at `classTable[offset]`? */
function classMatch(classTable: number[], offset: number, c: number, negated: boolean): boolean {
  const rangeCount = classTable[offset]!;
  let inside = false;
  let p = offset + 1;
  for (let i = 0; i < rangeCount; i++) {
    const lo = classTable[p]!;
    const hi = classTable[p + 1]!;
    p += 2;
    if (c >= lo && c <= hi) {
      inside = true;
      break;
    }
  }
  return negated ? !inside : inside;
}

function asciiFold(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code + 0x20;
  return code;
}

function isLineTerminator(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

/**
 * Run `prog` against `input` starting at `startIdx`. Returns the filled
 * capture array on a match (anchored at `startIdx`), or null on no match /
 * step-cap exceeded. This is a single anchored attempt — callers (test/exec/
 * match) drive the start position scan.
 */
export function runAt(
  prog: number[],
  classTable: number[],
  nGroups: number,
  input: string,
  startIdx: number,
): Int32Array | null {
  const nSlots = 2 * nGroups;
  const initCaps = new Int32Array(nSlots).fill(-1);
  const stack: Frame[] = [];
  let pc = 0;
  let sp = startIdx;
  // Explicit `Int32Array` (not the narrower `Int32Array<ArrayBuffer>` the
  // compiler infers from `new Int32Array(...)`) so reassignment from
  // `frame.caps` / `.slice()` (both `Int32Array<ArrayBufferLike>`) typechecks
  // under the stricter lib in CI.
  let caps: Int32Array = initCaps;
  let steps = 0;
  const len = input.length;

  for (;;) {
    if (++steps > REGEX_STEP_CAP) return null;
    const op = prog[pc * 3]!;
    const a = prog[pc * 3 + 1]!;
    const b = prog[pc * 3 + 2]!;
    let failed = false;

    switch (op) {
      case ReOp.CHAR: {
        if (sp < len && input.charCodeAt(sp) === a) {
          sp++;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.CHARI: {
        if (sp < len && asciiFold(input.charCodeAt(sp)) === a) {
          sp++;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.ANY: {
        if (sp < len && (a !== 0 || !isLineTerminator(input.charCodeAt(sp)))) {
          sp++;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.CLASS: {
        if (sp < len && classMatch(classTable, a, input.charCodeAt(sp), b !== 0)) {
          sp++;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.SPLIT: {
        // Try `a` first; push `b` as the backtrack alternative.
        stack.push({ pc: b, sp, caps: caps.slice() });
        pc = a;
        break;
      }
      case ReOp.JMP: {
        pc = a;
        break;
      }
      case ReOp.SAVE: {
        caps = caps.slice();
        caps[a] = sp;
        pc++;
        break;
      }
      case ReOp.BOL: {
        if (sp === 0) pc++;
        else failed = true;
        break;
      }
      case ReOp.EOL: {
        if (sp === len) pc++;
        else failed = true;
        break;
      }
      case ReOp.MATCH: {
        return caps;
      }
      default:
        return null;
    }

    if (failed) {
      const frame = stack.pop();
      if (!frame) return null;
      pc = frame.pc;
      sp = frame.sp;
      caps = frame.caps;
    }
  }
}

/**
 * Full search: scan start positions `startIdx..len` (sticky callers pass a
 * pre-clamped range via a single `runAt`). Returns the first match's caps or
 * null.
 */
export function search(
  prog: number[],
  classTable: number[],
  nGroups: number,
  input: string,
  startIdx: number,
  sticky: boolean,
): Int32Array | null {
  const len = input.length;
  for (let i = Math.max(0, startIdx); i <= len; i++) {
    const m = runAt(prog, classTable, nGroups, input, i);
    if (m) return m;
    if (sticky) return null;
  }
  return null;
}
