---
id: 2937
title: "Regression: host-mode $Object-hash poison (#2849) makes compiled-acorn parse null-deref on every input"
status: done
completed: 2026-07-02
created: 2026-07-02
updated: 2026-07-03
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: object
goal: runtime-eval
sprint: 69
parent: 2927
depends_on: []
related: [2849, 2584, 2432, 1712, 1710, 2850, 2853, 2944]
---

> **RESOLVED — RE-LAND WITH ESCAPE DISCIPLINE (2026-07-02).** Full factual
> chain: (1) PR #2432 (#2849) extended the `objectHashConsumerVars` poison to
> host → compiled-acorn null-dereffed on EVERY host input (this issue, bisected
> to `4173306a9b29`). (2) Interim revert PR **#2462** was bot-parked at −137 on
> the strict gate (it un-fixed #2849's flips), then **owner admin-merged at
> 2026-07-02T04:50:32Z** (`06e47fd`) — acorn parsed again, ~146 #2849 flips
> re-broke, `tests/issue-2849.test.ts` host arms `it.fails`-pinned to #2944.
> (3) The **re-land PR** (this one) re-drops the host gate TOGETHER with the
> #2944 escape discipline, satisfying BOTH constraints: the #2849 host arms
> are back to plain `it` and pass, AND compiled-acorn parses (dogfood corpus
> 21/23 equal±quirks, 0 REAL divergences — above the 13 pre-regression
> watermark; the 2 THREW are pre-existing #2850 + acorn-self). See the
> "Root Cause (final)" and "Fix (the re-land)" sections below; the "Fix
> direction" / "Reduction status" sections are the earlier investigation
> record.

# #2937 — host-mode `$Object`-hash poison regresses compiled-acorn to a uniform null-deref

**Blocker for #2927** (Acorn-via-js2wasm interpreter foundation) and for the
prior acorn self-host work (#2850 / #2853), which this regression **masks**.

## Symptom

On current `main` (`c26fc059a3422`), the compiled-Acorn parser throws at
runtime for **every** input — including the empty program `""`:

```
parse("")            => TypeError: Cannot access property on null or undefined
parse("1")           => TypeError: Cannot access property on null or undefined
parse("var x = 1;")  => TypeError: Cannot access property on null or undefined
```

The `#1712` differential corpus harness went from **13 equal±quirks / 8 real / 1
threw** (documented in `tests/dogfood/CORPUS-GAP-MAP.md`, re-run 2026-06-30) to
**22 / 22 `compiled-parse-threw`**. The throw fires on `""` too, so it happens
during **parser setup** (the `Parser` constructor / `getOptions`), before any
real parsing — i.e. it is upstream of the input-specific gaps #2850/#2853, which
can no longer be observed until this is fixed.

The compile itself still succeeds and the binary still validates — this is a
pure **runtime** null-deref (`typeErrorThrowInstrs` in
`src/codegen/property-access.ts`), a member access on a receiver that is null at
runtime when it should be a live object.

## Root cause — bisected

`git bisect` (compile Acorn → `parse("1")`; GOOD = returns a `Program`, BAD =
null-deref) over the 2026-07-01 evening merge batch pins the first bad commit:

```
4173306a9b29f3d1884cebf6e1972dea32508c75
fix(#2849): extend $Object-hash poison to host so static writes don't shadow the sidecar
(landed via PR #2432 — issue-2849-acorn-ecmaversion-normalize)
```

That commit, in `src/codegen/declarations.ts` (`collectEmptyObjectWidening`),
**dropped the `if (ctx.standalone)` gate** around the `markObjectHashConsumers`
loop so the `#2584` `objectHashConsumerVars` **poison applies in host mode too**:

```ts
// BEFORE (standalone-only):
if (ctx.standalone) {
  for (const s of stmts) markObjectHashConsumers(s, varName, ctx.objectHashConsumerVars);
}
// AFTER (#2849 — host too):
for (const s of stmts) markObjectHashConsumers(s, varName, ctx.objectHashConsumerVars);
```

The poison keeps a `{}` var that has **both** dynamic-key access (`o[k]=`, for-in,
`in`, `Object.keys/values/entries`) **and** static-named access on the `$Object`
sidecar, suppressing widening into a closed WasmGC struct. #2849 needed this in
host mode to fix the acorn `getOptions` for-in-copy shape (ecmaVersion `2022`
read back as `0` instead of `13`). But extending the poison to host mode makes
some access shape Acorn uses read back a **null receiver**, and the null guard
throws.

## Root Cause (final — instrumented to the exact site)

Instrumenting `typeErrorThrowInstrs` with per-site ids + the compiled function
name pinned the throw to **`getOptions`**, at the null-guarded `struct.get`
fast path in `emitNullGuardedStructGet`, reading **`__anon_4.ecmaVersion`** —
a widened anonymous struct that could NOT be `options`'s own (its widening was
poison-suppressed). The mechanism, verified by a minimal repro:

1. Acorn compiles as a **JS-mode** source (`fileName: "acorn.mjs"`). In JS
   special mode the TS checker **EVOLVES** `var options = {}` through its later
   static-named writes (`options.ecmaVersion = …` etc.) into an anonymous
   object type WITH those properties. **TS mode has no equivalent** — `{}`
   stays the empty type there, which is why (a) the #2849 tests (compiled as
   TS) stayed green while acorn broke, and (b) dev-2927's 7 reduced shapes
   (all `fileName: "t.ts"`) never reproduced. JS-mode evolution was the
   missing ingredient, not shape size.
2. The #2584/#2849 poison is honored **only at the widening decision**
   (`collectEmptyObjectWidening`). The evolved checker type independently
   flows through `resolveWasmType` → `ensureStructForType`, auto-registers a
   closed `__anon_N` struct, and types the **local** — and every ESCAPE
   position: `getOptions`'s return type, the `Parser.options` class field,
   receivers at read sites — as `(ref null __anon_N)`.
3. The poisoned initializer builds a **host plain object**
   (`__new_plain_object` → externref). The declaration's guarded cast of that
   externref into `(ref null __anon_N)` fails → stores `ref.null`.
4. First static read (`options.ecmaVersion === "latest"`, the first statement
   after the for-in copy) hits the null-guarded `struct.get` → uniform
   `TypeError: Cannot access property on null or undefined` at parser setup.

Minimal repro (`tests/issue-2937.test.ts`): the getOptions escape shape as
`repro.mjs` throws pre-fix / returns 13 post-fix; the identical source as
`repro.ts` never threw (no evolution).

## Fix (the re-land) — type-keyed escape discipline (#2944)

`ctx.objectHashConsumerTypes: Set<ts.Type>` — when the poison suppresses
widening for a var (host lanes only), `collectEmptyObjectWidening` records the
var's **evolved** checker type (guards: `!ctx.standalone`, not `any`,
`getProperties().length > 0` so TS-mode empty `{}` types are never recorded).
Three resolution funnels refuse struct resolution for a recorded type:

- `resolveWasmType` (index.ts) → returns externref
- `ensureStructForType` (index.ts) → early-returns (never registers the
  `__anon` struct)
- `resolveStructName` (property-access.ts) → returns undefined (receivers
  route through the externref host-MOP path)

Because return types, class-field types, params, and aliases all resolve
through the **same `ts.Type` object identity**, the single type-keyed check
delivers the full #2944 escape discipline (return / field / param / alias)
without per-site chasing: the poisoned value stays externref end to end and
every access form (static dot, computed bracket, for-in, escape reads) routes
through the host MOP (`__extern_get`/`__extern_set`) coherently. In host mode
the `$Object` is a real JS object, so the MOP is fully correct.

**Byte-diff verification (sha256, main vs re-land):** ONLY the host lanes of
poisoned shapes change (the intended #2849 behavior change + this coherence
fix). Standalone lanes (all shapes, both file modes), TS-mode non-poisoned,
static-only and general programs are **byte-identical**.

**Validation:** `tests/issue-2849.test.ts` 11/11 with the host arms back to
plain `it`; `tests/issue-2937.test.ts` 4/4; dogfood corpus **21/23
equal±quirks, 0 REAL divergences** (pre-regression watermark 13/22; the 2
THREW — `corpus/regex.js` (#2850) and acorn-self-parse — are documented
pre-existing gaps); compiled-acorn `parse("")`/`parse("1")`/`parse("var x =
1;")` all return `Program`.

**Known residual (out of scope, separate value-rep layer):** acorn's
_defaulting_ path (`getOptions({})`) copies `defaultOptions.ecmaVersion` —
a `null`-valued field on a NON-empty literal's closed struct — which stores
null as f64 `0`, so the copy reads back `0` (not `null`) and the `== null`
defaulting arm never fires (returns 0 instead of 11). This null-in-struct-
field representation gap PRE-DATES the whole #2849/#2937 chain (never green
in any build) and is invisible to the corpus (which passes an explicit
`ecmaVersion`). Documented in `tests/issue-2937.test.ts` as a non-throwing
known-residual assertion; candidate follow-up for the #2896 value-rep family.

## Fix direction (confirmed) — and why a plain revert is NOT acceptable

Re-adding the `ctx.standalone` gate makes compiled-Acorn parse again (verified —
the bisect probe returns GOOD with the gate restored). **But** re-gating
reintroduces the exact #2849 host bug (getOptions `2022 → 0`) and breaks the host
assertion in `tests/issue-2849.test.ts`. So the fix must **preserve #2849 while
not regressing the broader host-mode `$Object` read path** — either:

1. Fix the host-mode `$Object` read path so a poisoned object reads correctly for
   **all** access shapes (not just the for-in-copy shape #2849 tested), or
2. Narrow the host-mode poison trigger to the precise for-in-write→static-widen
   divergence #2849 needs, leaving Acorn's shape on the (working) struct/Proxy
   fast path.

`(1)` is the principled fix. `(2)` risks reintroducing #2849 for the narrowed-out
shapes and needs the exact Acorn trigger to draw the line safely.

## Reduction status

Seven reduced shapes did **NOT** reproduce (they return the correct value in host
mode on current main): for-in-copy of a primitive with a poisoning static write
(`o.extra=1`); object-valued copy + chained read; bracket-write of an object +
member access; copy-then-local + member access; **object escape** (poisoned
object returned from a function and read chained by the caller); poisoned object
stored on `this.options` and read by a method; and a `getOptions`-exact
default-copy + `in`-guard + `ecmaVersion` normalise (returns `13` correctly). So
the trigger is a **larger / class-shaped** Acorn pattern, not a trivial one.

**Recommended next reduction step:** instrument `typeErrorThrowInstrs` /
`emitNullCheckThrow` to emit a **per-call-site-unique** message (the current
throw has line/col `0`, so it can't be located from the payload), recompile
Acorn, and read which member-access site fires — then reduce from that site.

### Reduced shapes (verbatim — all returned the CORRECT value in host mode on

current `main`; extend these toward the Acorn trigger)

Each is `compile(src, { fileName: "t.ts" })` → instantiate → `wrapExports` →
`exp.test()`. All 7 returned the expected number (no throw):

```ts
// P1 — for-in copy of a primitive + a poisoning static write, static read (=13)
const src: any = { ecmaVersion: 13 };
const o: any = {};
for (const k in src) {
  o[k] = src[k];
}
o.extra = 1;
return o.ecmaVersion;

// P2 — copied value is an OBJECT, then chained read (=42)
const inner: any = { v: 42 };
const src: any = { node: inner };
const o: any = {};
for (const k in src) {
  o[k] = src[k];
}
o.extra = 1;
return o.node.v;

// P3 — bracket-write of an object, static read returns object, member access (=7)
const o: any = {};
const key = "node";
o[key] = { v: 7 };
o.flag = 1;
return o.node.v;

// P4 — static read of copied object into a local, then member access (=99)
const inner: any = { v: 99 };
const src: any = { keywords: inner };
const o: any = {};
for (const k in src) {
  o[k] = src[k];
}
o.pos = 0;
const kw: any = o.keywords;
return kw.v;

// E1 — ESCAPE: poisoned object RETURNED from a fn, caller reads chained (=42)
function make(): any {
  const src: any = { ecmaVersion: 13, node: { v: 42 } };
  const o: any = {};
  for (const k in src) {
    o[k] = src[k];
  }
  o.extra = 1;
  return o;
}
// test(): const opts: any = make(); return opts.node.v;

// E2 — ESCAPE via `this`: ctor builds poisoned obj on this.options, method reads (=13)
class P {
  options: any;
  constructor(opts: any) {
    const src: any = opts;
    const o: any = {};
    for (const k in src) {
      o[k] = src[k];
    }
    o.extra = 1;
    this.options = o;
  }
  read(): number {
    return this.options.ecmaVersion;
  }
}
// test(): const p = new P({ ecmaVersion: 13 }); return p.read();

// E3 — getOptions-exact: default-copy + `in`-guard + ecmaVersion normalize (=13)
const defaults: any = { ecmaVersion: 5, sourceType: "script" };
function getOptions(opts: any): any {
  const options: any = {};
  for (const opt in defaults) {
    options[opt] = opts && opt in opts ? opts[opt] : defaults[opt];
  }
  if (options.ecmaVersion >= 2015) {
    options.ecmaVersion -= 2009;
  }
  return options;
}
// test(): const o: any = getOptions({ ecmaVersion: 2022 }); return o.ecmaVersion;  // 13
```

The Acorn `Parser` constructor is class-based and combines `getOptions` (E3
shape) with keyword/reserved-word table construction and prototype-method
dispatch on `this` — the trigger is likely the **interaction** of the poisoned
options/state object with a larger class + prototype-walk shape, not any single
snippet above. Bisecting Acorn's own source (or the instrumented-throw-site
approach) is the fastest route to the exact member access.

## Repro

Deterministic, committed, one command (the #1710 dogfood harness):

```bash
# in a worktree off current main:
ln -s /workspace/node_modules node_modules
npx tsx tests/dogfood/acorn-corpus.mjs        # 22/22 compiled-parse-threw
```

Minimal throw-payload probe (extracts the real thrown value via the exported
`__exn_tag`): compile pinned acorn (`skipSemanticDiagnostics: true`),
instantiate, `wrapExports`, call `parse("")` — throws `TypeError: Cannot access
property on null or undefined`.

## Impact

- **Invisible to test262** (Acorn is not in the suite; the baseline stayed
  33,147 across the #2432 merge), so no conformance gate caught it — the dogfood
  harness is the only thing that did. This is the case for wiring the corpus
  harness into a CI signal (follow-up).
- **Blocks the entire #2927 critical path** ("Acorn source → valid Wasm that
  parses hello-world") and **masks** #2850 / #2853 (they cannot be re-verified
  until the parser survives setup).
- Likely regresses other **host-mode** programs with the same
  dynamic-key-write + static-named-access `{}` shape at scale.

## Acceptance criteria

- [x] Compiled-Acorn `parse("")` / `parse("1")` return a `Program` in host mode
      (dogfood corpus back to ≥ the 2026-06-30 baseline: ≥13 equal±quirks —
      measured 21/23, 0 REAL divergences).
- [x] `tests/issue-2849.test.ts` still passes (host `2022 → 13` preserved —
      all host arms restored to plain `it`, 11/11).
- [x] Standalone codegen byte-identical (poison was already on there — no change;
      sha256-verified across the byte-diff corpus).
- [x] A regression test captures the Acorn-shaped null-deref (reduced repro, or a
      guarded compiled-Acorn smoke assertion in `tests/`).
