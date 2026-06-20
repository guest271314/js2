---
id: 2520
title: "Ambient global-function host-import warning flood under --target wasi (collapse to a --verbose summary)"
status: done
sprint: 64
created: 2026-06-19
updated: 2026-06-20
completed: 2026-06-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: host-imports
goal: correctness
---

## Resolution (2026-06-20)

Fixed by **collapsing the per-import warnings into a one-line summary in the CLI,
restorable with `--verbose`** — NOT by the referenced-names gate originally
proposed below.

Why the lighter fix is the right one: the per-import "Host import "env.X" … not on
the dual-mode allowlist" warning (`registry/imports.ts` `addImport`,
severity `"degrade"`) fires for *every dropped* host import, then the import is
dropped and dead-code-eliminated — it **never reaches the `.wasm`**. The
authoritative check is a *different*, emit-time scan (`assertNoLeakedHostImports`,
severity `"error"`) that fires only if a host import actually *survives* into the
binary. So the per-import warnings are redundant noise: under `--target wasi`
essentially any program (anything referencing `Uint8Array`/`Date`/`Map`/…) trips
~60 of them. The allowlist *budget* test (`host-import-allowlist-budget.test.ts`)
governs the allowlist's size, not these warnings, so it is unaffected.

Implemented: `src/cli.ts` collapses the allowlist warnings to
`"N host import(s) … were dropped (no-op under WASI/strict mode; not in the
emitted .wasm). Re-run with --verbose to list them."`; `--verbose`/`-v` restores
the full per-import listing. Test: `tests/issue-2520-host-import-warning-verbosity.test.ts`.

The collection-stage over-emission (registering all ambient globals) still exists
but is now invisible (dropped + summarized). The optional referenced-names gate
(#2509) would additionally avoid the wasted collection work, but is not needed to
silence the noise. Original analysis kept below for reference.

## Problem

Compiling any source that touches a single lib global (e.g. `Uint8Array`,
`DataView`, `ArrayBuffer`, `Date`, `Map`, or a regex literal) injects a host
import (`env.<name>`) for the **entire** ambient global-function surface of
`lib.es5` + `lib.dom` — `eval`, `isNaN`, `alert`, `scroll`, `fetch`,
`matchMedia`, `createImageBitmap`, `postMessage`, `setTimeout`, … — regardless
of whether the user code references any of them.

Under `--target wasi` / `--no-host-imports` strict mode each unreferenced import
trips the dual-mode allowlist warning, producing a wall of ~60 warnings on an
otherwise trivial program. In JS-host mode they are ~60 spurious imports the
host environment must satisfy, and they bloat the import section and `.wat`.

Reported by an external user (guest271314) compiling the Native Messaging host
example as a `.js` file — see loopdive/js2#389. Distinct from the `.js` build
fix in #2195 (#1717); this is import over-emission, not a build error.

## Reproduction (verified on main `19612a24`)

```js
// flood.js — entire body
function main() {
  const a = new Uint8Array(4);
  a[0] = 1;
  return a[0];
}
```

```
npx tsx src/cli.ts flood.js --target wasi -o .
# → 60 warnings: Host import "env.eval" / "env.alert" / "env.fetch" /
#   "env.scroll" / "env.matchMedia" / "env.createImageBitmap" / ...
# The file references NONE of these names.
```

## Root cause

`src/codegen/index.ts`:

1. `sourceUsesLibGlobals()` returns true when the file references any name in
   `LIB_GLOBALS` (includes `Uint8Array`, `DataView`, `ArrayBuffer`, `Date`,
   `Map`, `Error`, regex literals, …).
2. That gates a scan running `collectExternDeclarations()` over the lib
   `lib.*.d.ts` source files (`index.ts:1076` single-file path, `index.ts:5173`
   multi-file path).
3. Inside `collectExternDeclarations`, the `declare function … (no body)` arm
   (`index.ts:~11124`) registers an `env.<name>` import for **every** ambient
   `declare function` in that lib file, gated only by `!ctx.funcMap.has(name)` —
   with **no check that the name is referenced in user source**.

The sibling `collectDeclaredGlobals()` (for `declare const`/DOM classes, right
above) **does** gate on a `referencedNames` set ("only register used globals").
The `declare function` path is missing that exact gate, so one benign lib-global
use drags in the whole ambient global-function surface.

## Fix

Add the same referenced-names gate to the lib-file `declare function` emission:
register `env.<name>` only for ambient functions actually referenced as
identifiers in user source.

- Gate **only** the lib-file invocations of `collectExternDeclarations`
  (`index.ts:1076`, `:5173`).
- Do **not** gate the user-file call (`index.ts:1062`): there the bodiless
  `declare function` stubs come from `preprocessImports` for unresolved external
  imports and must always register so call sites pass args correctly.

Mechanically mirror `collectDeclaredGlobals`: collect `referencedNames` from the
user source once, pass it into `collectExternDeclarations` (or a lib-specific
variant), and skip `addImport` for any `declare function` whose name is not in
the set. Real `setTimeout`/`fetch`/etc. usage still resolves because the name
appears as an identifier in user source.

## Acceptance criteria

- The reproduction above (`new Uint8Array(4)` only) emits **0** `env.*`
  ambient global-function imports under `--target wasi`.
- A file that genuinely calls e.g. `setTimeout(...)` still registers
  `env.setTimeout` (non-WASI) / behaves as before.
- Regression test asserting the `Uint8Array`-only case produces zero ambient
  global-function host imports.

## Follow-up

`referencedNames` collects property-access names too, so `obj.close` would still
spuriously match `env.close`. Tracked separately in #2509 (lower priority).
