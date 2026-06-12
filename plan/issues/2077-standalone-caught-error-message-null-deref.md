---
id: 2077
title: "standalone: caught Error's .message traps null deref; .name returns '[object Object]' (catch-bound value isn't the $Error struct)"
status: in-progress
sprint: 63
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: exceptions
goal: host-independence
related: [1104, 1536, 2072]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2077 — $Error struct field reads on a non-$Error catch binding

## Problem

```ts
try { throw new Error("msg1"); } catch (e: any) { const m: string = e.message; return m; }
// standalone: RuntimeError: dereferencing a null pointer   node: "msg1"
```

`e.name` on a TypeError yields "[object Object]" (node: "TypeError").
`e instanceof TypeError/Error` works — only the field reads break.

## Root cause

`src/codegen/property-access.ts:1448-1457` — standalone reads `$Error`
struct fields 1/2 for message/name, but the catch-bound value isn't that
struct after the throw/catch roundtrip → null field. Residual of #1104
(done); #1536 (backlog, $Error redesign) is the structural home.

## Fix direction

Preserve the `$Error` struct identity through the exception tag payload
(or re-cast with a guarded ref.test before the field read); the
"[object Object]" half also intersects #2072's `$__any_to_string` shape
mismatch.

## Acceptance criteria

- Both repros match Node standalone; instanceof behavior unchanged
- throw/rethrow of non-Error values unaffected

## Dupe check

#1104 (done — regressed/residual), #1536 (backlog redesign), #1597. Filed
as the concrete standalone residual.

## Root-cause analysis (2026-06-12) — TWO independent bugs

Deep investigation (standalone target, nativeStrings) found this is **two**
stacked bugs. Fixing only the first does not make the repro pass.

### Bug 1 (FIXED here) — the field-read fast path is statically gated

`property-access.ts` only emitted the standalone `$Error` `struct.get`
fast path when the receiver's **static** TS type was a builtin Error
(`isErrorLhs`). A `catch (e)` binding is typed `any`, so the gate never
fired and `e.message`/`e.name` fell through to the generic `__extern_get`
host path — which returns null in standalone mode (no host). This is why
the direct case (`const e = new Error("m"); e.message`) worked but the
caught case (`catch (e: any) { e.message }`) returned null.

**Fix (this PR):** when the receiver is `any`/`unknown` (`isErrorLikeRuntimeLhs`)
and we're in `ctx.wasi || ctx.standalone`, emit a runtime
`ref.test $Error`–guarded read (mirrors the standalone instanceof guard in
`identifiers.ts`): if the value IS an `$Error` struct, `ref.cast` +
`struct.get` the field + coerce to the native string ref; else produce a
null string. Verified the emitted WAT is now byte-identical to the working
direct-`Error` path (same struct type index, same `extern→$AnyString`
coercion). Regression-clean: #1104 phase1/2/3 + #1536 (30 tests) green,
#1597 (5) green, tsc clean.

### Bug 2 (REMAINING — blocks the repro) — message string identity lost through the exception payload

With Bug 1 fixed, the guarded read now **recovers the struct** (proven:
`e instanceof Error` is true, the read's `ref.test $Error` is true, the
message is non-null and self-equal: `m === m` → 1, `m === null` → 0,
`typeof m` is a native string). **But** the recovered message does NOT
content-equal a literal after a throw/catch roundtrip:

| case | `e.message === "msg1"` | `e.message.length` |
|------|------------------------|--------------------|
| `const e = new Error("msg1")` (direct) | 1 ✓ | 4 ✓ |
| `try{throw new Error("msg1")}catch(e:any)` | **0 ✗** | **0 ✗** |
| fresh `new Error("xy")` *inside* the catch | 2 ✓ | — |

A plain `throw "msg1"; catch(e){ e === "msg1" }` → 1 (string identity
survives the tag for a bare string). So the corruption is specific to the
**string stored in the `$Error` struct's `message` field** surviving the
wasm exception-tag `extern.convert_any`/`any.convert_extern` roundtrip:
the caught struct's message reads back as a *different* (non-null,
self-consistent) `$AnyString` that fails content-equality with literals.

This is the `$Error`-struct-identity-through-exception-payload problem the
issue's "Fix direction" anticipated, and it intersects #2072's
`$__any_to_string`/native-string-shape work and the #1536 `$Error`
redesign. It is a **separate, larger change** (exception payload + native
string representation) — not a property-access fix. Recommend routing the
remaining piece to senior-dev / folding into #1536/#2072.

### Status

`status: in-progress` — Bug 1 (the field-read gate) is fixed and landed;
Bug 2 (exception-payload string identity) remains and blocks the repro.
