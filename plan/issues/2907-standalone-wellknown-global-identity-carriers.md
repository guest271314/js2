---
id: 2907
title: "Standalone: native well-known-global bare-value carriers (global_<Name> leak)"
status: done
assignee: ttraenkler/sendev-globals
completed: 2026-07-01
created: 2026-07-01
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: 69
horizon: l
related: [2866, 2696, 2520, 1888, 1065]
---

# Standalone: native well-known-global bare-value carriers

## Problem

Referencing a well-known global as a **first-class object VALUE** — not a method
call, not a `new` callee — under `--target standalone` leaked an
`env.global_<Name>` host import to materialize the global's identity. Standalone
has no JS host to satisfy it, so the module could not instantiate host-free and
failed the standalone floor.

The native METHOD bodies already exist (`Math.*` #1902, `JSON.*` #1538/#2166,
native throw/catch #1536, static `instanceof <Error>` tag registry #1325); the
gap was only the bare-value BINDING.

## Root cause (measured on origin/main, 2026-07-01)

Two `global_<Name>` emission loops in `src/codegen/index.ts::collectDeclaredGlobals`:

1. **declared-globals loop** (~13826): emits `global_<Name>` for any
   `isExternalDeclaredClass` lib global. `TypeError`, `Error`, `RegExp`,
   `Reflect`, the `*Error` subtypes are **NOT** in `BUILTIN_TYPES`
   (`src/checker/type-mapper.ts`), so they pass `isExternalDeclaredClass` and hit
   this loop. It had **no host-import guard at all**.
2. **ambient-ctor loop** (~13906, #1065): emits `global_<Ctor>` for
   `AMBIENT_BUILTIN_CTORS` used as bare values (`Math`, `JSON`, TypedArray
   ctors, …). Its #2696 guard was `if (ctx.strictNoHostImports) continue;`.

The real defect: **`strictNoHostImports` is NOT auto-on for `standalone`** —
`create-context.ts:25` sets it from `options.strictNoHostImports ?? options.wasi
?? false`, i.e. only `wasi`. So both loops leaked `global_<Name>` under
standalone even though standalone is a no-JS-host target. `instanceof <Error>` is
resolved statically (`builtin-tags.ts` negative-tag registry) and `new
X(...)`/`X(...)` are intercepted at the call/new site BEFORE identifier
resolution, so **only genuine bare-VALUE uses leaked**.

### Measured cluster (targeted leaking-idiom corpus, `wrapTest` + `--target standalone`)

Sampling the ~650 test262 files matching the bare-value idioms
(`expectedError = TypeError`, `[TypeError, RangeError]`, `Object.isFrozen(Math)`,
`Object.getPrototypeOf(Reflect)`, `instanceof <Error>` inside bodies):

- **`global_TypeError` dominates** (sole ~11 / touch ~29 per 200-sample →
  ~35 sole / ~90+ touch corpus-wide). `global_JSON` sole 4/4 (pure-JSON tests).
  `global_Math`, `global_Reflect`, `global_String`, `global_Number`,
  TypedArray-ctor group (`[Int8Array, …].forEach`) also leaked.
- The dominant `assert.throws(TypeError, fn)` inline form is **stripped by the
  harness** (`transformAssertThrows`), so the leak rides mainly on the INDIRECT
  idiom (`expectedError = TypeError; assert.throws(expectedError, fn)`) and on
  value-used-as-object cases.

### Honest net finding (measure-first)

Removing the leak flips these tests **host-free** (the stated acceptance), but
the immediate PASS-conversion is smaller than the sole-count suggests: many
sole-`global_` tests fail for **unrelated** reasons once host-free (e.g. the
DataView `resizable-buffer` cluster needs resizable-ArrayBuffer support, not the
`TypeError` binding). The genuine pass conversions come from **value-used-as-
object** cases where the null-default gave a wrong answer — those need a real
extensible object carrier (`Object.isFrozen(Math) === false`,
`Object.isSealed(Math) === false`, `typeof Math === "object"`).

## Fix (this PR)

All changes gated `ctx.standalone` (or `strictNoHostImports`) — **gc/host mode is
byte-identical** (verified: 469-byte program using TypeError/Error/RangeError/
Math/JSON/Reflect as values compiles to an identical binary on main vs branch,
host still provides `global_*`).

1. **`codegen/index.ts` — extend both `global_<Name>` guards to
   `ctx.strictNoHostImports || ctx.standalone`.** Standalone stops leaking the
   host constructor object; bare-value uses fall through to the native carrier or
   the `ref.null.extern` graceful default. (The ambient-loop comment claiming
   strict mode was "auto-on for standalone" was factually wrong and is corrected.)

2. **`codegen/builtin-static-globals.ts` — native bare-value carriers** for the
   well-known namespace + Error-family globals via the existing #1888
   `emitBuiltinNamespaceObject` infra (an EMPTY supported-prop list ⇒ materialize
   an extensible `$Object` singleton for the bare identifier without claiming any
   static property):
   `Math`, `JSON`, `Reflect`, `Error`, `TypeError`, `RangeError`, `SyntaxError`,
   `ReferenceError`, `EvalError`, `URIError`, `AggregateError`.
   `isSupportedBuiltinStaticProperty(ns, m)` stays **false** for all of these, so
   `Math.PI` / `JSON.stringify` / `Reflect.ownKeys` keep their existing
   property-access fast paths (intercepted at the property-access site, before
   identifier resolution of the receiver). `new TypeError(...)` /
   `throw new RangeError(...)` / `e instanceof TypeError` are unchanged
   (native-error construction / static tag registry, both pre-identifier).

### Verified (host-free, empty-import instantiation)

- Leaks gone: `expectedError = TypeError`, `[TypeError, RangeError, …]`,
  `Object.isFrozen(Math)`, DataView `expectedError = TypeError` — all 0 imports,
  no `global_`.
- Conversions fail→pass: `Object.isFrozen(Math) === false`,
  `Object.isSealed(Math) === false`, `typeof Math === "object"`, bare `TypeError`
  truthy, `Object.isFrozen(TypeError) === false`.
- No hot-path regression: `Math.PI`/`Math.max`/`Math.floor`, `JSON.stringify`/
  `JSON.parse`, `Reflect.ownKeys`/`Reflect.has`, `new`/`throw`/`instanceof` for
  the Error family — all still pass host-free.
- gc-mode byte-identical; `tsc --noEmit` clean; `tests/issue-2907.test.ts` 10/10.

## Follow-ups (deferred, documented for the next slice)

- **Canonical-singleton identity** — `Object.getPrototypeOf(Reflect) ===
Object.prototype` and `[].filter(fn, JSON)` thisArg-identity (`this === JSON`)
  still return the wrong answer: the carrier singleton is not `===`-identical to
  the canonical `Object.prototype` / the value re-read at the comparison. Needs
  the carrier interned as THE one canonical object and threaded identically as a
  thisArg. (Value-rep follow-up.)
- **`.name` / `.prototype` on the Error-family carriers** (`TypeError.name ===
"TypeError"`, `TypeError.prototype`) — the empty carrier returns `undefined`.
  Populate the carrier with `name`/`prototype` where cheap.
- **WASI parity** — the carrier is `ctx.standalone`-gated; bare `Math`/`TypeError`
  under `--target wasi` still resolves to the `ref.null.extern` default (already
  host-free, just not carrier-backed). Extend to wasi for consistency.
- **`RegExp`/`Date`/`String`/`Number`/`Boolean`/`Function` bare-value carriers**
  — lower-frequency; same infra, add when their sole-clusters justify a slice.

## Acceptance

- `global_<Name>` sole tests flip host-free (verified). ✓
- gc byte-unchanged (verified). ✓
- Value-used-as-object conversions (`isFrozen`/`isSealed`/`typeof`) pass. ✓
- Full `merge_group` standalone floor is the conformance gate.
