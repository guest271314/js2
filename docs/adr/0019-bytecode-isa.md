# ADR-019 — Bytecode interpreter ISA: register+accumulator, i32-packed encoding, side exception table

**Status**: Accepted
**Date**: 2026-07-17
**Issue**: #3101 (E1 of the standalone bytecode interpreter; slice E of the
`runtime-eval` roadmap, #2928/#1584)
**Context doc**: [docs/architecture/runtime-eval-interpreter.md](../architecture/runtime-eval-interpreter.md)
Part II §12–§16 (bytecode-over-tree-walking ADR §13; unified `$EnvRec` name
resolution §14; slice sequence §16).
**Implements**: `src/interp/` (opcodes, encoder, ESTree→bytecode emitter,
dispatch loop, disassembler); tested in Node against node-acorn
(`tests/interp/`).

## Context

Tier 2 of the runtime-eval ladder is a **standalone WasmGC-native bytecode
interpreter**: when there is no JS host and the source is not compile-time
constant, dynamic JavaScript (`new Function`, indirect `eval`) runs on a compact
interpreter embedded in the module. The representation decision (bytecode over
tree-walking; register+accumulator over stack) was made in the architecture doc
§13. This ADR pins the **concrete ISA** — opcode set, instruction encoding,
exception-table format, and the AOT↔interpreter call protocol — exactly as
implemented in E1 (`src/interp/`), so E2 (#2928) can self-compile the library
and wire it to standalone `new Function`/`eval` without re-litigating the design.

E1 is authored in the js2wasm-compilable TypeScript subset but developed and
unit-tested **in Node against node-acorn** — zero Wasm, zero substrate risk (it
is a new `src/interp/` directory that touches no existing compiler code). E2
compiles it with js2wasm itself.

## Decision

### 1. Machine model — register + accumulator (Ignition-style)

One implicit accumulator `acc` (boxed-any) plus a per-frame register file
`regs[0..regCount)` (boxed-any, mutable). Most ops read/write `acc`; binary ops
take one register operand and compute `acc = op(regs[r], acc)`. This yields
fewer instructions per source operation than a stack machine and maps virtual
registers 1:1 onto Wasm locals when the loop self-compiles (the #1715 dispatch
proof).

**Register convention** (an E1 decision; #3101 left receiver placement open):

```
regs[0]                    = the receiver (`this`)            [reserved]
regs[1 .. 1+paramCount)    = the declared parameters
regs[1+paramCount .. )     = hoisted locals + expression temporaries
```

`__interp_enter` seeds `regs[0]=thisArg` and `regs[1..]=args`; a
`ThisExpression` lowers to `Ldar 0`. Keeping the receiver in a normal register
means the `$Frame` layout stays exactly the #3101/#2864-coordinated shape (no
extra field).

### 2. Values — the AOT boxed-any substrate, no interpreter-private kinds

Every operand (accumulator, register, const-pool entry, env slot) holds the same
`anyref`/`$Object` rep the AOT path produces. In E1's Node authoring that is
TypeScript `any` (a real JS value); when js2wasm self-compiles the library it is
the AOT boxed-any rep. All arithmetic/comparison/property/typeof operations are
written as **plain native operations on `any` operands** in `runtime-ops.ts`
(`function anyAdd(a, b) { return a + b; }`, …). That single choice makes the
value-representation bridge free in both directions:

- In Node, `a + b` runs JavaScript's own `+` (full ToPrimitive/ToNumber), so the
  interpreter is bit-identical to `eval` — the differential harness's premise.
- When js2wasm compiles those helpers, `a + b` on two `any` operands lowers to
  the AOT `__any_add` generic runtime op (`compileAnyBinaryDispatch`,
  `src/codegen/binary-ops.ts`); `===` → the strict-eq helper preserving `ref.eq`
  identity; member access → `__dyn_member_get`/`__extern_set`.

Consequently **no opcode carries a runtime-type assumption** and ToPrimitive/
ToNumber live in the helpers, never in the dispatch loop.

### 3. Encoding — i32-packed, one word per instruction

`code` is an `array (mut i32)` (`number[]` in Node — every packed word is a
≤32-bit integer, f64-exact, and the loop reads it back with `& 0x7f`/`>>> shift`,
which coerce to i32 in js2wasm). One base word:

```
word = op | (a << 8) | (b << 20)
  op  bits 0..7    opcode 0..63 in bits 0..6; bit 7 = WIDE flag
  a   bits 8..19   12-bit unsigned (register / const-pool index / small immediate)
  b   bits 20..31  12-bit unsigned (second register / small immediate)
```

Dispatch is `word & 0x7f` — a dense `br_table`. Three trailing-word conventions
sit on top of the base word:

- **WIDE (bit 7)** — when operand `a` (a const-pool index or a jump target) does
  not fit in 12 bits, the base word sets bit 7 and the true `a` follows in one
  trailing i32 word. `b` is always packed (register indices, `argc`, and builtin
  ids are always < 4096, so `b` never needs to be wide).
- **Jumps are always WIDE** — `Jump`/`JumpIfTrue`/`JumpIfFalse` always carry a
  trailing absolute-PC target word, so a forward jump reserves a full target slot
  and back-patching never has to guess a size (the target is unknown at emit
  time). Jumps are **absolute PCs** (simpler emitter back-patching than relative).
- **`CallBuiltin` carries a third operand** (`argc`) in a trailing word: the base
  word packs `a`=builtinId, `b`=rArgsBase; the trailing word is argc.

The **disassembler** (`disasm.ts`) renders `pc: OpName a, b  ;; const` and is the
debugging contract — no blind-in-Wasm debugging.

### 4. Opcode set — 37 opcodes

#3101's header says "34 ops"; its opcode **table** enumerates 37 distinct
mnemonics (verified by count). The "34" predates 3 table additions; E1
implements all 37 enumerated ops.

| Group      | Opcodes                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------- |
| const/reg  | `LdaConst c` `LdaUndef` `LdaNull` `LdaTrue` `LdaFalse` `LdaZero` `Star r` `Ldar r` `Mov a,b`   |
| arith/cmp  | `Add r` `Sub r` `Mul r` `Div r` `Mod r` `Neg` `Not` `TypeOf` `Eq r` `StrictEq r` `Lt r` `Le r` |
| property   | `GetProp c` `GetElem r` `SetProp c,r` `SetElem rK,rV`                                          |
| variables  | `LdGlobal c` `StGlobal c` `LdName c` `StName c`                                                |
| calls      | `Call rBase,argc` `Construct rBase,argc` `CallBuiltin id,rBase,argc`                           |
| control    | `Jump t` `JumpIfTrue t` `JumpIfFalse t` `Return`                                               |
| exceptions | `Throw`                                                                                        |

The ISA is deliberately **minimal**: it has `Lt`/`Le`/`Eq`/`StrictEq` but not
`>`/`>=`/`!=`/`!==` (the emitter desugars: `a > b`→`b < a`, `a >= b`→`b <= a`,
`a != b`→`!(a==b)`, `a !== b`→`!(a===b)`), and `+x`→`-(-x)` (double-negate =
ToNumber). Object/array literals and closures are **builtins**, not opcodes
(fewer ops, same cost class): `CallBuiltin` targets `%ObjectLiteral%`,
`%ArrayLiteral%`, `%MakeClosure%`, `%TypeofName%` (non-throwing `typeof` of a
possibly-undeclared identifier), `%GlobalThis%`. In E2 the generic-runtime
builtins route through the #2927 audited `CallBuiltin(name, recv, argsVec)`
surface; the interpreter-intrinsic ones are frame-aware and handled in the loop.

### 5. Exception regions — a side table, not opcodes

Deviation from the #2928 sketch's `TryStart`/`TryEnd` opcodes, deliberate. The
`$FuncMeta` carries a flat **exception table** (`array (mut i32)`, four ints per
row):

```
[startPC, endPC, handlerPC, handlerReg]   (half-open [startPC, endPC))
```

The dispatch loop wraps execution in a Wasm `try_table` (a JS `try/catch` in E1);
on catch it scans the current frame's table for the innermost (tightest-span)
row covering the throwing PC, writes the caught value into `regs[handlerReg]`,
and jumps to `handlerPC`. On a miss it unwinds one frame — rescanning the caller
at its **call-site PC** (the return PC is one past the `Call`, which would fall on
`tryEnd` and miss the half-open interval) — and, if the frame stack empties,
rethrows across the host boundary (E4 replaces that with a Wasm EH tag). Rationale:
zero cost on the non-throwing path, no paired-opcode invariant for the emitter to
break, and it matches how the AOT lane already uses EH tags. `finally` compiles to
a duplicated block on the normal path (the standard bytecode answer); full
finally-intercepts-control-flow is a follow-up (see Scope). Genuine
interpreter-invariant violations use a distinct `InterpInternalError` that
**bypasses** the exception table, so a loop bug can never be masked by a program
`try/catch`.

### 6. Types — the WasmGC struct ABI

Authored as TS classes so js2wasm lowers each to a `struct`
(`src/interp/types.ts`). `$Frame` field order is **frozen** — coordinate with
#2864 (the generator/async carrier shares it) before changing.

```
$FuncMeta = { code: (ref i32-array), consts: (ref anyref-array), regCount: i32,
              paramCount: i32, exnTable: (ref null i32-array), name: anyref,
              flags: i32 }        flags: bit0 strict, bit1 generator*, bit2 async*
                                  (*#2929), bit3 SCRIPT (E1: return the eval/script
                                  completion value)
$Frame    = { meta: (ref $FuncMeta), pc: (mut i32), regs: (ref anyref-array),
              envRec: (ref null $EnvRec), parent: (ref null $Frame) }
$EnvRec   = { kind: i32 (0 decl | 1 object | 2 global), parent: (ref null $EnvRec),
              names: anyref, slots: (ref null anyref-array), backing: anyref }
```

### 7. Call protocol — `__interp_enter` (E2's contract)

An interpreted function value is an ordinary **closure struct** whose code
pointer is the single exported trampoline
`__interp_enter(meta, envRec, thisArg, argsVec) -> anyref` and whose capture slot
holds the `$FuncMeta`. To every AOT call site (and the #3098 classifier) it is
**indistinguishable from a compiled closure** — call dispatch needs zero
interpreter-awareness in codegen. `__interp_enter` allocates the `$Frame` (regs
from `regCount`), seeds the param/receiver registers, runs the loop, returns
`acc`. interp→interp calls do **not** recurse the host stack: `Call` pushes a new
`$Frame` and swaps the loop's cached state (suspension-ready, #2929); only the
host boundary uses host recursion. Both directions preserve `ref.eq` identity by
construction (one value rep).

### 8. Name resolution — global record only (Phase 1)

`LdName`/`StName` walk the `$EnvRec` chain (doc §14); `LdGlobal`/`StGlobal` are
the root-only fast case. Phase 1 constructs only the **global** record
(`kind = global`, `backing = globalThis`); a root miss throws a typed, catchable
`ReferenceError`. Indirect eval / `new Function` are always global scope
(§19.2.1 / §20.2.1.1) — top-level `var`/`function` create **global** bindings
(not registers), so a nested function's free identifier resolves to them by
global lookup (this is global resolution, **not** the lexical capture Phase 1
excludes). Declarative-record internals (name-map carrier + slots) land with
#2925/#2929.

## The E1↔E2 seam (what necessarily differs between Node and Wasm)

E1 runs in Node; the pieces below are Node stand-ins for Wasm ABIs, isolated and
documented so E2 re-realizes them without touching opcode semantics:

1. **Interpreted-function value** — E1: a branded JS function (WeakMap) that calls
   `interpEnter`. E2: a closure struct whose code pointer is `__interp_enter`.
2. **Host dispatch** — E1: `callee.apply` / `Reflect.construct`. E2: the #3098
   classifier / `__apply_closure`.
3. **Global env backing** — E1: `Object.create(globalThis)` (real globals via the
   prototype, declarations isolated). E2: the module globalThis `$Object` (#369).
4. **Exception routing** — E1: a JS `try/catch` around dispatch + the exn-table
   scan. E2: a Wasm `try_table` + EH-tag propagation (E4).

## Scope — Phase 1 in / out

**In:** var/let/const (function-scoped; no TDZ), if/else, while/for/do-while,
break/continue (incl. labeled), binary/unary/logical/ternary, member get/set,
object/array literals, calls/new, function declarations/expressions/arrows
(global-scope, capture = none), templates, throw, try/catch/finally (side table).

**Out (documented follow-ups, tracked against #2928/#2929):**

- `switch`, `class`, `for-in`/`for-of`, generators/async — deferred node kinds
  (the emitter throws `UnsupportedNodeError`; the differential harness skips and
  reports them).
- Bitwise/shift/`**` operators, `delete`, `in`, `instanceof` — the arith group is
  deliberately minimal; extending it is a follow-up.
- Destructuring and spread (params, patterns, call/array/object).
- Regex literals (shared-state correctness; aligns with #3301).
- Lexical closure capture, block scoping, TDZ, strict-mode undeclared-assignment
  ReferenceError — the declarative-`$EnvRec` work (#2925/#2929).
- Real global-var hoisting onto the module globalThis and cross-eval visibility
  (E3, #2928) — invisible to E1's completion-value differential.

## Consequences

- E2 self-compiles `src/interp/` unchanged (the tsc project gate — `src/**` under
  `tsc --noEmit` — already covers it); js2wasm gaps surface as #1058 child issues,
  the intended self-host stress test.
- The frame-stack + side-table exception model is the one #2929 suspends and E4
  bridges to Wasm EH — no v2 of the `$Frame` layout is needed.
- Validation (E1): 113 Node tests pass; the interpreter agrees with `eval`
  (isolated in `node:vm`) on a 65-body curated corpus and ~91% of supported
  sampled real test262 eval bodies (remaining divergences are the documented
  Phase-1 limits above).

## Alternatives considered

Recorded in the architecture doc §13 (bytecode over tree-walking) and §3.2
(self-compiled TS interpreter over hand-WAT VM / QuickJS-bridge / meta-circular).
This ADR does not re-open them; it pins the concrete ISA the accepted strategy
requires.
