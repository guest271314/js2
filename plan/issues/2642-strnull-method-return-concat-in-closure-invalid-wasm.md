---
id: 2642
title: "Stale cached __wasi_write_string funcIdx across a late-import boundary emits invalid Wasm for a console.log of a string|null/undefined concat under --target wasi"
status: done
completed: 2026-06-24
sprint: 65
goal: wasi-async-runtime
feasibility: medium
kind: bug
created: 2026-06-24
updated: 2026-06-24
refs: [2632, 2641, 1677, 1903, 2039, 2563, 1461, 2193]
---

# Class method `string | null` return, concatenated in a closure → invalid Wasm

## Problem

A **class method** whose return type is `string | null`, whose result is narrowed
(`x !== null`) and then **string-concatenated** (`"r:" + x`) **inside a closure**,
compiles to **invalid Wasm** under `--target wasi`:

```
WebAssembly.compile(): Compiling function #N:"__closure_0" failed:
  call[0] expected type (ref null 6), found i32.const of type i32
```

Type 6 is the native-string i16-array tree; `(ref null 6)` is the string-ref the
concat helper expects as its first operand. In the `null` arm the value is lowered
as an `i32.const` (the null/sentinel representation), and that i32 reaches the
concat-call operand slot where a `(ref null 6)` is required — a
union-representation desync between the `null` and `string` arms of the method's
return, surfacing only at the concat site **inside a closure body**.

## Minimal reproduction

```ts
class R {
  private c: string = "ABCDE";
  read(n: number): string | null {
    if (this.c.length < n) return null;
    const h = this.c.substring(0, n);
    this.c = this.c.substring(n);
    return h;
  }
}
const r = new R();
const cb = () => {
  let x = r.read(2);
  while (x !== null) { console.log("r:" + x); x = r.read(2); }  // "r:" + x triggers it
};
cb();
```

Compile `--target wasi --skipSemanticDiagnostics` → `WebAssembly.validate` is
**false**.

## What is and isn't affected (narrowed)

Verified by bisection (probes in `.tmp/` during #2632 Phase 3):

| Shape | Result |
|---|---|
| `read(): string \| null` method, `"r:" + x` **inside a closure** | **INVALID** |
| Same, but `console.log(x)` directly (no concat) | valid |
| Same, but narrow first (`const y: string = x; "r:" + y`) | valid |
| Same method + concat, but at **top level** (no closure) | valid |
| **Free function** (not a method) returning `string \| null`, concat in closure | valid |

So the trigger is the **conjunction**: (class **method** return `string | null`) ×
(result **string-concatenated**, not first re-narrowed to a fresh `string` local) ×
(**inside a closure** body). Removing any one of the three makes it valid.

This is in the same native-string finalize/representation family as #2641 (which
fixed the *let/const-shadowing-a-global* variant) and #1677 / #1903 / #2039 /
#2563. #2641 did **not** cover this union-return-in-closure concat variant.

## Impact / why it matters

Surfaced building the faithful `process.stdin` Readable (#2632 Phase 3). Node's
`Readable.read([size])` faithfully returns `string | null`; the prelude returns it
correctly. A consumer who writes the idiomatic
`while ((x = stdin.read(3)) !== null) console.log("r:" + x)` (inline concat of the
nullable result inside the `readable` callback closure) hits this bug. The Phase-3
prelude + tests **work around** it by narrowing-then-calling-a-function
(`function emit(c: string){ console.log("r:" + c); }`), which is valid — but the
inline form should compile.

## Acceptance criteria

- [ ] The minimal reproduction above compiles to **valid** Wasm under `--target wasi`
      and runs (prints `r:AB`, `r:CD`, `r:E` for "ABCDE").
- [ ] The `string | null` (and more generally `T | null` for ref types) method
      return is boxed consistently across the `null` and value arms so the concat
      (and other string-consuming) call sites see a uniform `(ref null <str>)`.
- [ ] Zero test262 regression; the #2632 Phase-3 inline-concat form added to
      `tests/issue-2632-phase3-stdin-prelude.test.ts` (currently using the
      narrow-then-call workaround) can be switched to the inline `"r:" + x` form.

## Notes for the implementer

The desync is at the concat operand, NOT the method body itself (the method
validates in isolation). The closure capture + the `string | null`→`externref`
boxing of the captured loop local `x` is where the `null`-arm i32 and the
string-arm ref representations diverge. Start from the closure codegen path that
boxes a captured `T | null` local and the string-concat helper's operand coercion
(`coerceType` for the first operand). This is a fragile index-shift / value-rep
area — pair with an architect review before changing the boxing (see #2632 Phase-3
notes and the native-string finalize-shift memory cluster).

## Resolution (2026-06-24) — VERIFIED root cause: stale funcIdx, NOT closure boxing

The closure / class-method / `process.stdin` framing above is **all incidental**.
The minimal repro is a plain **free function**:

```ts
function rd(): string | null { return "x"; }
export function main(): void { const x = rd(); if (x !== null) { console.log("r:" + x); } }
```

Compiled `{ target: "wasi" }` → invalid Wasm
(`call expected (ref null N), found i32.const`) on main. (The earlier "free
function ... valid" bisection row was misled by a coincidental shape; the true
trigger is *insert-a-late-import while compiling a console.log argument, then
write again with a cached helper index*.)

### Root cause

`compileConsoleCallWasi` (and the sibling `emitWasiValueToStdout`) in
`src/codegen/expressions/builtins.ts` read `__wasi_write_string`'s function index
**once** (`const writeStringIdx = ctx.funcMap.get(helperName)`) and reused it for
the separator / template-part / trailing-newline / `[object]`-placeholder writes.

Compiling the inline-concat argument whose value is a `string | null` /
`string | undefined` externref union inserts the `__extern_toString` late import
via `ensureLateImport` + `flushLateImportShifts` (`src/codegen/binary-ops.ts`),
which shifts **every** function index by +1. The trailing newline / separator
writes then emitted the **stale** index → post-shift it resolves to a *different*
function (`__regex_escape`, a `(ref null N)` parameter), so the `i32.const`
offset/length operands meant for `__wasi_write_string` fail the `call` type check
→ `call expected (ref null N), found i32.const` → invalid module.

Same family as `reference_1461_reduce_noinit_funcidx_desync` /
`reference_2193_call_ref_funcref_not_wrapper`.

### Fix

Re-resolve the helper index **by NAME** from `ctx.funcMap` at every emission site
that writes *after* a `compileExpression` / `ensure*Helper` call (via a local
`writeStr(offset, length)` helper in both functions). No funcIdx is held across
the union-concat argument's compilation.

**Invariant (enforced + commented in both functions):** a funcIdx read once must
NEVER be reused across an `ensureLateImport` / late-import insertion — re-read it
from `ctx.funcMap` (by name) after any call that can add an import.

### Validation

`tests/issue-2642.test.ts` — 5 validity guards (string|null, string|undefined,
union-concat as first of multiple args, union-concat + a second console.log, and
the `console.warn` stderr-helper variant), each failing `WebAssembly.compile`
pre-fix and passing post-fix, + 2 negative-control runtime stdout checks. Per
#1968 (shared-state index-shift family) an isolated byte-diff would be a FALSE
NEGATIVE, so the guard is "the module validates"; full `merge_group` / test262
re-validation in CI confirms byte-neutrality for programs that do not hit the
union-concat-then-write pattern. tsc + biome lint clean.
