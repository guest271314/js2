// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Bytecode dispatch loop (#1715 / #1584) — the TypeScript stack VM that executes
// the opcode stream {@link BytecodeEmitter} produces.
//
// Written in plain TypeScript ON PURPOSE: #1584's eventual design is to compile
// the dispatch loop itself with js2wasm, so the loop must be expressible in the
// language subset js2wasm already handles (numbers, locals, a switch, a loop,
// arrays-as-stack). This proof keeps it to that subset so the #1584 follow-up
// can lift it without a rewrite.
//
// Execution model: a stack machine over `number[]`. Locals are an array (args
// then declared locals); the operand stack is a `number[]`. Booleans are 1.0 /
// 0.0 (matching the emitter's CMP_* ops and JS truthiness for the JZ branch).
// All values are JS numbers (f64) — the #1715 subset is numeric only.
//
// #1584 a1 (call family): the single-function `runBytecode` generalises to a
// MULTI-FRAME call-stack machine, `runProgram`, over a function table. A
// `CALL`/`CALL_REF` pushes a call frame (saving the caller's pc/locals/code/
// constPool) and installs the callee's; `RET` pops the frame and resumes the
// caller with the callee's top-of-stack pushed. `runBytecode`/`runSink` stay as
// the single-function entry (the bottom frame) for the #1715 numeric proofs.
//
// Cross-family value representation (locked with the emitter, see issue §2a):
//   - funcref ≡ f64(tableIndex)  — a function reference is the f64 of its index
//     in `program.functions`. null-funcref ≡ f64(-1); `CALL_REF` on -1 traps.
//   The stack/locals domain stays homogeneous f64; this is safe because the
//   bytecode is well-typed by construction (lower.ts only emits `CALL_REF` on a
//   slot it statically knows is a funcref — the Wasm type system upstream
//   guarantees it), so the VM does not tag-check.

import { type BytecodeSink, OP } from "./bytecode-emitter.js";

/**
 * One entry in a {@link Program}'s function table. A function lowers to its own
 * {@link BytecodeSink} (own `code` + own `constPool` + own jump address-space),
 * so a call switches BOTH `code` and `constPool` and the call frame restores
 * both on return.
 */
export interface FuncEntry {
  // NOTE: array-typed fields are `number[]`, NOT `readonly number[]`. When this
  // VM is itself compiled by js2wasm (the slice-(b) Wasm-GC-VM arm), a `readonly`
  // array nested as a struct field lowers to an immutable WasmGC array variant
  // whose nested-field read after an index TRAPS. Plain `number[]` lowers
  // correctly. (The VM never mutates these, so dropping `readonly` is a codegen
  // accommodation, not a semantic change.)
  /** The function's opcode stream (`sink.code`). */
  code: number[];
  /** The function's f64 immediate pool (`sink.constPool`). */
  constPool: number[];
  /** Declared parameter count — `CALL` pops this many args (arity not inline). */
  arity: number;
  /**
   * Local-slot count (params + declared locals). A call installs a fresh
   * `locals[nLocals]` seeded `locals[0..arity-1]` with the popped args; higher
   * slots are lazily 0-init on first `LOAD` (same contract as `runBytecode`).
   */
  nLocals: number;
  /**
   * #1584 a4 try-throw: the STATIC per-function exception table (table-scan
   * model). `THROW` scans it for the innermost entry whose `[tryStart, tryEnd)`
   * covers the throwing pc, then truncates the value stack to `spAtEntry`, pushes
   * the exn, and jumps to `catchTarget`. `TRY_START`/`TRY_END` are runtime
   * no-ops (the table is authoritative). Array-of-objects with number-only
   * fields (no `readonly`/nested-struct — same js2wasm-codegen accommodation as
   * the FuncEntry array fields). `spAtEntry` is always 0 today (`try` is a
   * statement-level node with an empty operand stack at entry), but it travels
   * in the entry for correctness if a non-statement `try` ever appears.
   */
  exceptionTable: ExcEntry[];
}

/** One protected region in a {@link FuncEntry}'s {@link FuncEntry.exceptionTable}. */
export interface ExcEntry {
  /** Absolute code index of the region start (inclusive). */
  tryStart: number;
  /** Absolute code index of the region end (exclusive). */
  tryEnd: number;
  /** Absolute code index of the catch arm to jump to on a covered throw. */
  catchTarget: number;
  /** Value-stack depth at try-entry; the stack is truncated to this on catch. */
  spAtEntry: number;
}

/**
 * A whole compiled program: a function table plus the entry function index.
 * `runProgram` runs `functions[entry]` as the bottom frame.
 */
export interface Program {
  // `functions` is `FuncEntry[]` (not `readonly`) for the same js2wasm-codegen
  // reason as FuncEntry's fields above.
  functions: FuncEntry[];
  entry: number;
}

/** Bounded step guard — turns a malformed stream (missing RET / bad backpatch)
 *  into a clear failure instead of a hang. Proof programs are tiny.
 *  (No numeric `_` separator — the js2wasm parser that compiles this file for
 *  the slice-(b) Wasm-GC-VM arm rejects them.) */
const MAX_STEPS = 1000000;

/** Sentinel f64 value for a null function reference (`CALL_REF` traps on it). */
const NULL_FUNCREF = -1;

/** Sentinel f64 value for a null struct reference (`STRUCT_GET`/`SET` trap). */
const NULL_STRUCT = -1;

/**
 * Run a whole {@link Program} — the multi-frame call-stack VM (#1584 a1).
 *
 * @param program  function table + entry index
 * @param args     initial values of the entry function's locals 0..arity-1
 * @returns the number the entry function's `RET` leaves on the stack
 */
export function runProgram(program: Program, args: readonly number[]): number {
  const { functions } = program;

  // VM-global state (outlives any single frame): module globals
  // (GLOBAL_GET/SET), lazily 0-init on first access.
  const globals: number[] = [];

  // VM-global heap (#1584 a2, STRUCT_NEW/GET/SET). A heap object is a record
  // with a `fields` array; `heap[i]` is the object at heap index `i`. A struct
  // reference is encoded as f64(heapIndex) on the stack/locals/fields domain
  // (the cross-family invariant locked with the emitter: null-struct ≡ f64(-1)).
  // The heap is VM-global, NOT per-frame — returned structs outlive the frame
  // that created them. A struct field holding a funcref stores f64(tableIndex)
  // (a1's funcref encoding), so STRUCT_GET of a closure's func field yields a
  // value CALL_REF can dispatch (the closure.call bridge, once a5 ref.cast lands).
  interface HeapObject {
    fields: number[];
  }
  const heap: HeapObject[] = [];

  // The operand stack is shared across frames (Wasm-style: a callee pops its
  // args from / pushes its result onto the same value stack). Locals/pc/code/
  // constPool are per-frame.
  const stack: number[] = [];

  // Call-frame stack: each entry is the SUSPENDED caller's state, restored on
  // RET. The currently-executing function's state lives in the mutable locals
  // below (not on this stack until it calls out).
  interface Frame {
    pc: number;
    locals: number[];
    // `number[]` not `readonly number[]` — see the FuncEntry note: a `readonly`
    // array nested as a struct field traps when this VM is js2wasm-compiled.
    code: number[];
    constPool: number[];
    // The function's exception table travels per-frame too, so a THROW that
    // unwinds into a caller scans THAT caller's table (#1584 a4).
    excTable: ExcEntry[];
    // The call-site pc (the CALL/CALL_REF opcode index) in the caller. When a
    // THROW unwinds into this caller, the region check uses the call-site — NOT
    // the saved return `pc` (which is one-past the call, outside `[tryStart,
    // tryEnd)`). Width-agnostic across CALL (2 slots) / CALL_REF (2 slots).
    callSite: number;
  }
  const frames: Frame[] = [];

  // Install the entry function as the bottom (currently-executing) frame.
  const entryFn = functions[program.entry];
  if (entryFn === undefined) {
    throw new Error(`bytecode-vm: entry funcIdx ${program.entry} out of range`);
  }
  let code = entryFn.code;
  let constPool = entryFn.constPool;
  // The currently-executing function's exception table (#1584 a4). Swapped on
  // CALL/CALL_REF + restored on RET, just like `code`/`constPool`.
  let excTable = entryFn.exceptionTable;
  // Entry locals: args copied into slots 0..arity-1 (the #1715 contract — the
  // entry behaves like `runBytecode(args)`); slots above args.length are lazily
  // 0-init on first LOAD.
  let locals: number[] = args.slice();
  let pc = 0;

  let steps = 0;
  for (;;) {
    if (++steps > MAX_STEPS) throw new Error("bytecode-vm: step budget exceeded (malformed program?)");
    const op = code[pc++];
    switch (op) {
      case OP.CONST:
        stack.push(constPool[code[pc++]!]!);
        break;
      case OP.LOAD:
        stack.push(locals[code[pc++]!] ?? 0);
        break;
      case OP.STORE: {
        const idx = code[pc++]!;
        locals[idx] = stack.pop()!;
        break;
      }
      case OP.ADD: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a + b);
        break;
      }
      case OP.SUB: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a - b);
        break;
      }
      case OP.MUL: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a * b);
        break;
      }
      case OP.CMP_GT: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a > b ? 1 : 0);
        break;
      }
      case OP.CMP_LT: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a < b ? 1 : 0);
        break;
      }
      case OP.CMP_GE: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a >= b ? 1 : 0);
        break;
      }
      case OP.CMP_LE: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a <= b ? 1 : 0);
        break;
      }
      case OP.CMP_EQ: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a === b ? 1 : 0);
        break;
      }
      case OP.NEG:
        stack.push(-stack.pop()!);
        break;
      case OP.JZ: {
        const target = code[pc++]!;
        if (stack.pop() === 0) pc = target;
        break;
      }
      // #1584 a3 control-flow: JNZ is the exact dual of JZ (emitter resolves
      // block/loop/br/br_if to JZ/JNZ/JMP + backpatched absolute targets; the VM
      // only ever sees the conditional/unconditional jumps). `br_if` maps here.
      case OP.JNZ: {
        const target = code[pc++]!;
        if (stack.pop() !== 0) pc = target;
        break;
      }
      case OP.JMP:
        pc = code[pc++]!;
        break;
      case OP.RET: {
        // Pop this frame's result. If there is no caller, it's the program
        // result. Otherwise restore the caller (pc/locals/code/constPool) and
        // push the callee's result onto the (shared) caller stack.
        //
        // NOTE: check `frames.length` BEFORE popping — `[].pop()` on an empty
        // array TRAPS when this VM is itself compiled by js2wasm (a WasmGC array
        // out-of-bounds, not a JS `undefined`). The entry function's RET hits
        // this empty case on every program exit, so the length guard is load-
        // bearing for the slice-(b) compiled-VM arm, not just defensive.
        const result = stack.pop()!;
        if (frames.length === 0) return result;
        const caller = frames.pop()!;
        pc = caller.pc;
        locals = caller.locals;
        code = caller.code;
        constPool = caller.constPool;
        excTable = caller.excTable;
        stack.push(result);
        break;
      }
      // ── #1584 production additions (DIV..UNREACHABLE) — wired in lockstep with
      // the emitter's OP enum (sdev-emitter owns OP; the VM realizes each). ──
      case OP.DIV: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a / b);
        break;
      }
      case OP.CMP_NE: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(a !== b ? 1 : 0);
        break;
      }
      case OP.TEE: {
        // Peek top (do not pop) -> locals[idx]; leaves the value on the stack.
        const idx = code[pc++]!;
        locals[idx] = stack[stack.length - 1]!;
        break;
      }
      case OP.GLOBAL_GET: {
        const idx = code[pc++]!;
        stack.push(globals[idx] ?? 0);
        break;
      }
      case OP.GLOBAL_SET: {
        const idx = code[pc++]!;
        globals[idx] = stack.pop()!;
        break;
      }
      case OP.SELECT: {
        // pop cond, pop b, pop a -> push (cond != 0) ? a : b.
        const cond = stack.pop()!;
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(cond !== 0 ? a : b);
        break;
      }
      case OP.DROP:
        stack.pop();
        break;
      case OP.UNREACHABLE:
        // Maps from Wasm `unreachable` — a malformed / dead-code path. Trap
        // loudly (the standalone-Wasm analogue is `unreachable`; the host VM
        // throws so the equivalence test sees a clean failure, not a hang).
        throw new Error(`bytecode-vm: UNREACHABLE executed at pc ${pc - 1}`);
      // ── #1584 a1 call family (CALL / CALL_REF) ──
      case OP.CALL: {
        // CALL <funcIdx>: direct call. Args are already on the stack (arg0
        // deepest). Arity is NOT inline — read it from the callee's table entry
        // (mirrors Wasm `call $f`, where arity comes from the func type).
        const funcIdx = code[pc++]!;
        const callee = functions[funcIdx];
        if (callee === undefined) {
          throw new Error(`bytecode-vm: CALL funcIdx ${funcIdx} out of range at pc ${pc - 2}`);
        }
        // Save the caller, install the callee. callSite = the CALL opcode index
        // (`pc - 2`: opcode + 1 inline operand have been consumed).
        frames.push({
          pc,
          locals,
          code,
          constPool,
          excTable,
          callSite: pc - 2,
        });
        const calleeLocals = popArgsIntoLocals(callee, stack);
        locals = calleeLocals;
        code = callee.code;
        constPool = callee.constPool;
        excTable = callee.exceptionTable;
        pc = 0;
        break;
      }
      case OP.CALL_REF: {
        // CALL_REF <typeIdx>: indirect call through a funcref ON TOP of the
        // stack (lower.ts emits the funcref last). The typeIdx operand is
        // informational (arity/validation); the dispatch target is the funcref.
        // funcref ≡ f64(tableIndex); null ≡ f64(-1) traps.
        pc++; // consume the (informational) typeIdx operand
        const funcref = stack.pop()!;
        if (funcref === NULL_FUNCREF) {
          throw new Error(`bytecode-vm: CALL_REF on null funcref at pc ${pc - 2}`);
        }
        const idx = funcref | 0; // f64 -> i32 table index
        const callee = functions[idx];
        if (callee === undefined) {
          throw new Error(`bytecode-vm: CALL_REF funcref ${idx} out of range at pc ${pc - 2}`);
        }
        // callSite = the CALL_REF opcode index (`pc - 2`: opcode + 1 inline
        // typeIdx operand consumed; the funcref came off the stack).
        frames.push({
          pc,
          locals,
          code,
          constPool,
          excTable,
          callSite: pc - 2,
        });
        const calleeLocals = popArgsIntoLocals(callee, stack);
        locals = calleeLocals;
        code = callee.code;
        constPool = callee.constPool;
        excTable = callee.exceptionTable;
        pc = 0;
        break;
      }
      // ── #1584 a2 struct/object family (STRUCT_NEW / STRUCT_GET / STRUCT_SET) ──
      // Heap objects live in the VM-global `heap`; a struct ref ≡ f64(heapIndex);
      // null-struct ≡ f64(-1) (GET/SET on it traps). Field values are plain f64s
      // (a funcref field stores f64(tableIndex) — the a1 bridge).
      case OP.STRUCT_NEW: {
        // STRUCT_NEW <fieldCount>: pop fieldCount values (field0 deepest, pushed
        // in canonical field order), allocate a heap object, push its ref.
        const fieldCount = code[pc++]!;
        const fields: number[] = [];
        for (let i = fieldCount - 1; i >= 0; i--) {
          fields[i] = stack.pop()!;
        }
        heap.push({ fields });
        stack.push(heap.length - 1); // f64(heapIndex)
        break;
      }
      case OP.STRUCT_GET: {
        // STRUCT_GET <fieldIdx>: pop structRef, push obj.fields[fieldIdx].
        const fieldIdx = code[pc++]!;
        const ref = stack.pop()!;
        if (ref === NULL_STRUCT) {
          throw new Error(`bytecode-vm: STRUCT_GET on null struct at pc ${pc - 2}`);
        }
        const obj = heap[ref | 0]!;
        stack.push(obj.fields[fieldIdx]!);
        break;
      }
      case OP.STRUCT_SET: {
        // STRUCT_SET <fieldIdx>: stack [structRef, value] (value on top); pop
        // value, pop structRef, obj.fields[fieldIdx] = value, push nothing.
        const fieldIdx = code[pc++]!;
        const value = stack.pop()!;
        const ref = stack.pop()!;
        if (ref === NULL_STRUCT) {
          throw new Error(`bytecode-vm: STRUCT_SET on null struct at pc ${pc - 2}`);
        }
        const obj = heap[ref | 0]!;
        obj.fields[fieldIdx] = value;
        break;
      }
      // ── #1584 a4 try-throw family (THROW / TRY_START / TRY_END) ──
      // table-scan model: TRY_START/TRY_END are runtime no-ops (the per-function
      // exceptionTable is authoritative); THROW unwinds to the innermost covering
      // handler, popping call frames until a handler matches.
      case OP.TRY_START:
        // TRY_START <catchTarget>: no-op region marker; skip the inline operand.
        pc++;
        break;
      case OP.TRY_END:
        // TRY_END: no-op region marker (normal-exit boundary).
        break;
      case OP.THROW: {
        // Pop the exception value, then unwind. The THROW opcode's own index is
        // `pc - 1` (op was read with `code[pc++]`), and that is the pc used for
        // region coverage. Walk: scan the current fn's exceptionTable for the
        // INNERMOST covering entry (smallest [tryStart,tryEnd) with
        // tryStart ≤ throwPc < tryEnd); on a hit, truncate the value stack to
        // that region's spAtEntry, push the exn, jump to catchTarget. On a miss,
        // pop the call frame (restoring the caller's pc/locals/code/constPool/
        // excTable) and rescan the caller's table at its saved call-site pc.
        // If the frame stack empties with no handler, the throw escapes the
        // program: re-throw a host Error carrying the value (`runProgram` aborts).
        const exn = stack.pop()!;
        let throwPc = pc - 1; // index of the THROW (or the call-site after a pop)
        for (;;) {
          // Find the innermost covering handler in the current excTable.
          let bestIdx = -1;
          let bestSpan = Number.POSITIVE_INFINITY;
          for (let i = 0; i < excTable.length; i++) {
            const e = excTable[i]!;
            if (e.tryStart <= throwPc && throwPc < e.tryEnd) {
              const span = e.tryEnd - e.tryStart;
              if (span < bestSpan) {
                bestSpan = span;
                bestIdx = i;
              }
            }
          }
          if (bestIdx >= 0) {
            const handler = excTable[bestIdx]!;
            // Truncate the value stack to the try-entry depth (spAtEntry), then
            // push the exn for the catch arm to bind via STORE.
            stack.length = handler.spAtEntry;
            stack.push(exn);
            pc = handler.catchTarget;
            break;
          }
          // No handler here — unwind one frame.
          if (frames.length === 0) {
            throw new Error(`bytecode-vm: uncaught throw (value ${exn})`);
          }
          const caller = frames.pop()!;
          // Restore the caller. The rescan uses the CALL-SITE pc (the index of
          // the CALL/CALL_REF that entered the popped frame), which lies inside
          // any covering try region — NOT the saved return `pc` (one-past the
          // call, i.e. == tryEnd, which would fail the half-open coverage test).
          locals = caller.locals;
          code = caller.code;
          constPool = caller.constPool;
          excTable = caller.excTable;
          throwPc = caller.callSite;
          pc = caller.pc;
        }
        break;
      }
      default:
        throw new Error(`bytecode-vm: unknown opcode ${op} at pc ${pc - 1}`);
    }
  }
}

/**
 * Pop a callee's `arity` args off the shared stack (arg0 was pushed first, so
 * it is deepest) into a fresh `locals[0..arity-1]`. Higher local slots are
 * lazily 0-init on first `LOAD` (same as `seedLocals`).
 */
function popArgsIntoLocals(callee: FuncEntry, stack: number[]): number[] {
  const calleeLocals: number[] = [];
  for (let i = callee.arity - 1; i >= 0; i--) {
    calleeLocals[i] = stack.pop()!;
  }
  return calleeLocals;
}

/**
 * Run a single compiled bytecode function (the #1715 numeric proof entry).
 * Implemented as a one-function {@link Program} so the single- and multi-frame
 * paths share one dispatch loop.
 *
 * @param code      flat opcode + inline-operand stream (`sink.code`)
 * @param constPool f64 immediates referenced by `OP.CONST <poolIdx>` (`sink.constPool`)
 * @param args      initial values of locals 0..n-1 (the function parameters);
 *                  any higher local index used by STORE/LOAD is lazily 0-init.
 * @returns the number left on the stack by `OP.RET`
 */
export function runBytecode(code: readonly number[], constPool: readonly number[], args: readonly number[]): number {
  // arity = args.length so the entry seeds exactly the provided args; nLocals
  // is unbounded in practice (lazy 0-init), so any sufficiently large value
  // works — use args.length as the floor (higher slots lazily appear).
  // `.slice()` into mutable `number[]` for the FuncEntry fields (which are
  // `number[]`, not `readonly`, for the js2wasm-codegen reason noted above).
  const program: Program = {
    functions: [
      {
        code: code.slice(),
        constPool: constPool.slice(),
        arity: args.length,
        nLocals: args.length,
        // No try regions in the single-function #1715 numeric proof path.
        exceptionTable: [],
      },
    ],
    entry: 0,
  };
  return runProgram(program, args);
}

/** Convenience: run a {@link BytecodeSink}'s program as a single function. */
export function runSink(sink: BytecodeSink, args: readonly number[]): number {
  return runBytecode(sink.code, sink.constPool, args);
}
