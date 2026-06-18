---
id: 2191
title: "Standalone string === is intransitive for ≥0x80 strings built by a fresh codec helper"
status: ready
created: 2026-06-18
updated: 2026-06-18
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: standalone
language_feature: string
goal: standalone-mode
related: [40, 1588]
discovered_by: sdev-json3
---

# #2191 — standalone `__str_equals` intransitivity for ≥0x80 strings from a fresh helper

## Problem

Under `--target standalone`, a `$NativeString` produced by the #40 case-conversion
helper (`__str_to{Upper,Lower}Case` in `src/codegen/case-convert-native.ts`)
compares **UNEQUAL to a string LITERAL** under `===` (`__str_equals`) when the
string contains a code unit **≥ 0x80**, even though the two strings are
byte-for-byte identical. Strings with only ASCII (< 0x80) chars compare equal
correctly. The comparison is **INTRANSITIVE**, which is impossible for a correct
content-equality function — so this is a representation/equality bug, not a
mapping bug.

## Repro (all standalone, runtime param to defeat const-fold)

```ts
function f(s: string): number { return s.toUpperCase() === "À" ? 1 : 0; }
// f("à")  →  0   (WRONG — "à".toUpperCase() === "À" should be true)
```

Verified about the helper's output `a = "à".toUpperCase()`:
- `a.length === 1`, `a.charCodeAt(0) === 192`, `a.codePointAt(0) === 192` — all CORRECT.
- A manual `for`-loop char-by-char compare of `a` vs `"À"` returns **EQUAL**.
- `a === a` ✓, `a === fromCharCode(192)` ✓, `a === a.substring(0,1)` ✓,
  `a === (otherHelperCall)` ✓ — all TRUE.
- `a === "À"(literal)` ✗, `a.charAt(0) === "À"` ✗, `a.slice(0,1) === "À"` ✗,
  `(a + "") === "À"` ✗ — all FALSE.
- ASCII through the SAME helper (`"x".toUpperCase() === "X"`) ✓ — only ≥0x80 fails.
- Pre-existing methods producing ≥0x80 from a param (`substring`/`trim`/`padStart`/
  `concat`/`charAt`) `=== literal` ALL ✓.

So the failure is **uniquely** triggered by the case-conversion helper's output
struct (`struct.new $NativeString(len, 0, array.new_default(n)+array.set per char)`)
on the LHS with a string-literal RHS, for chars ≥ 0x80.

## What was ruled out (sdev-json3, ~75 min)

- NOT the case mapping — the bytes are provably correct (charCodeAt/codePointAt/
  manual-compare all agree).
- NOT the `off` field (charCodeAt reads `data[off+i]` correctly = 192).
- NOT the `len` field (`.length` = 1; `__str_equals` len-check would early-return
  but the byte loop is what mismatches).
- NOT array overallocation — `__str_equals` uses the struct `len` FIELD, not
  `array.len` (confirmed in the WAT).
- NOT signedness/masking — 192 is a clean positive i16.
- NOT `utf8Storage` (reproduces with it off), NOT the optimizer (reproduces
  with `optimize:false`), NOT helper-routing (the ASCII `__str_toUpperCase`
  body was rewritten to the Unicode one; still fails).
- NOT simply `array.new_default`+`array.set` — `padEnd`/`repeat` rebuild via
  the same idiom and their output `=== literal` works for ≥0x80.
- Routing the helper output through `__str_substring(out,0,len)` BEFORE return
  did NOT fix it — yet a TS-level `.substring()` on the SAME output DOES compare
  equal. (This internal inconsistency is the core mystery.)

The comparison genuinely reaches `__str_equals` (call to `__str_equals` in the
WAT, not `ref.eq`), and `__str_equals` flattens both operands via `__str_flatten`
(which fast-paths a `$NativeString` through unchanged) then byte-compares via
`array.get_u`. Two byte-identical 1-element i16 arrays at off 0 should compare
equal — but don't, for the helper's output specifically.

## Hypotheses for whoever picks this up

1. A Binaryen/WasmGC packed-i16 representation subtlety where a struct built by
   one instruction sequence vs another yields arrays that `array.get_u` reads
   identically but `__str_equals` (or `__str_flatten`'s `ref.test`/`ref.cast`)
   treats differently.
2. A static-type interaction: the case helper returns a concrete
   `(ref $NativeString)`; the comparison codegen may pick a different `===`
   lowering for a concrete-ref LHS + string-literal RHS than for a
   `(ref $AnyString)` LHS (substring/concat). Worth dumping the exact
   comparison codegen for `helperResult === literal` vs `substring === literal`
   and diffing the called functions / casts.
3. closest adjacent expertise: sdev-proxy3 (did the $Array/$ObjVec externref-rep
   + string-element work, #2190/#35).

## Impact

Blocks #40 (case conversion) from shipping — `assert.sameValue` / `===` against a
literal is how test262 String/case tests assert, so the case methods would report
failures despite producing correct output. Also a latent correctness risk for any
future codec that builds `$NativeString` structs directly.

## Acceptance criteria

- `"à".toUpperCase() === "À"` (runtime param) returns `true` standalone, and the
  intransitivity is gone for ≥0x80 strings from any builder.
- #40 case-conversion tests pass via `===` (not just charCodeAt readback).
