---
id: 2642
title: "Class method returning string|null, narrowed-and-concatenated inside a closure, emits invalid Wasm under --target wasi"
status: ready
sprint: Backlog
goal: wasi-async-runtime
feasibility: hard
kind: bug
created: 2026-06-24
refs: [2632, 2641, 1677, 1903, 2039, 2563]
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
