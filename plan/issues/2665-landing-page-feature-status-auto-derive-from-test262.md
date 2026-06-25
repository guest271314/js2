---
id: 2665
title: "dashboard: landing-page feature-support labels are hardcoded HTML, not auto-derived from test262 pass-rates (with/SAB/top-level-await/__proto__ etc. shown permanently 'not supported')"
status: done
completed: 2026-06-25
created: 2026-06-25
updated: 2026-06-25
priority: medium
feasibility: medium
task_type: bug
area: dashboard, website
goal: spec-completeness
sprint: 66
---

# #2665 — landing-page feature status must auto-derive from test262, not hardcoded HTML

## Problem (user-reported 2026-06-25)

The landing page (`website/index.html`) hand-codes per-feature support labels as
static prose/markup — e.g. line ~1857 `<pre>with (obj) { x; } // not supported</pre>`,
line ~2582 `new SharedArrayBuffer(1024); // not supported`, top-level-await
"Not yet supported", growable buffers "not yet supported", `__proto__` "not
supported", arguments "partially supported", RegExp "partially supported",
defineProperty "partially supported". These are **not derived from test262
results**, so:
- A feature reads "not supported" / "won't be supported" even when partial
  support exists or could be measured (e.g. `with` Tier-1 static shipped in
  #1387; see #2663 for Tier-2).
- The labels go stale silently — they never reflect the live pass-rate.

The per-feature DETAIL page (`website/public/benchmarks/feature-report.html`)
already does the right thing: it reads `passCount`/`totalCount`/`tests[]` from
`feature-examples.json` (augmented by `dashboard/build-data.js`) and shows a
live pass-rate. The LANDING-page catalog does not.

## Goal

Make every feature-support label in the landing-page catalog **auto-derive from
the corresponding test262 category pass-rate** (the same `feature-examples.json`
data the detail page uses), with a status threshold (e.g. ≥90% supported / ≥1%
partial / 0% not-yet — TBD), so labels update automatically on every
baseline refresh. Remove the hardcoded "not supported" / "won't be supported"
strings.

## Scope

1. Identify the canonical data: `feature-examples.json` (build-data.js) — each
   feature card on the landing page maps to one or more test262 `testCategories`.
2. Wire each landing-page feature card to its category pass-rate — either a
   build-time injection (preferred; the page is currently static HTML) or a
   client-side fetch+render of the support badge. Decide the approach.
3. Define the status thresholds (supported / partial / not-yet) and render a
   live badge + pass-rate, replacing the hardcoded prose label.
4. **AUDIT all features in these lists** (the user explicitly asked): enumerate
   every hardcoded support label in `website/index.html` (and any sibling list
   in `spec-compliance.html` / dashboard), confirm each now derives from its
   test262 category, and flag any feature with no mapped category (those need a
   category mapping or an explicit, justified manual status).
5. Keep prose EXPLANATIONS (the "why / how to work around it" text) but the
   support STATUS must be data-driven.

## Acceptance

- No hardcoded support-status strings remain in the landing-page catalog; every
  feature badge reflects its live test262 pass-rate.
- `with` shows its actual Tier-1 pass-rate (and updates when #2663 Tier-2 lands)
  rather than a static "not supported".
- An audit note in this issue lists every feature card → test262 category it now
  derives from (and any unmapped ones).

## Notes

- This is dashboard/website work (not core compiler) — dev-claimable.
- Coordinate the status-threshold definition so it's consistent with
  `spec-compliance.html`'s existing conforming/partial/not_implemented scheme.

---

## Resolution (2026-06-25)

The landing-page feature catalog (`website/index.html`, ~80 rows) is now
**data-driven from test262 pass-rates** on two layers, both keyed off the SAME
canonical source — `website/public/feature-examples.json` (the per-feature
aggregation written by `website/dashboard/build-data.js`, which buckets every
test262 result into exactly one feature with `passCount` / `totalCount` /
`testCategories`):

1. **Build-time bake** — `scripts/derive-feature-badges.mjs` was rewritten to
   match every catalog row by its `.feat-name` text (HTML-entity-decoded) to a
   feature in `feature-examples.json`, rewrite the badge tone from the live
   pass-rate, and **inject the feature's `testCategories` as `data-t262-paths`**
   on the row (rows with a `data-t262-paths` attribute jumped 27 → 75). It used
   to only key off the ~27 hand-authored `data-t262-paths` rows and read the
   depth-2 `test262-current.json` categories, which could not resolve
   fine-grained features (`Array.prototype.includes`, `annexB/.../anchor`, …).
   The PR-time `quality` gate `generate:feature-badges:check` reads the SAME
   committed `feature-examples.json`, so bake and gate are consistent by
   construction (no merge-queue wedge).
2. **Runtime overlay** — `hydrateFeatureBadges()` in `index.html` (replacing the
   old `hydrateFeatureRowCounts`) fetches the freshly-**deployed**
   `feature-examples.json`, matches each row by name, and DERIVES the badge
   (✓/⚠/✗) plus the `N / T` chip, `NN%` pill, report deep-link and test262
   source links. Because deploy-pages re-runs `build-data.js`, the deployed file
   (and therefore every badge) auto-updates on every baseline refresh — so
   `with` now shows its real `16 / 181` rate and will climb when #2663 lands,
   instead of a permanent static `✗ not supported`.

**Threshold** (consistent with the runtime `toneFor` and
`scripts/generate-feature-compatibility.ts`): `ratio ≥ 0.90 → full (✓)` ·
`0 < ratio < 0.90 → partial (⚠)` · `ratio == 0, total>0 → none (✗)` ·
`totalCount == 0 → keep static badge + flag` (no measurable data).

The `FEATURE_TEST_CATEGORIES` map was extracted from `build-data.js` into
`scripts/feature-test-categories.json` as the single shared source of truth so
the bake and the bucketing never drift.

### Hardcoded status strings removed (prose explanations kept)

`with`, `SharedArrayBuffer` ("// not supported" code comments); `arguments`,
RegExp, `Object.defineProperty` ("partially supported"); top-level-await,
Resizable ArrayBuffer, `Promise.withResolvers`, Change-array-by-copy
("not yet supported / implemented"); `__proto__` ("not supported"); HTML string
methods ("Not implemented"). Every "why / how-to-work-around" explanation was
preserved; only the *status claim* was removed (status is now the data-driven
badge).

### A. Derived from live test262 pass-rate (51 features)

| Feature card | test262 category (truncated) | pass/total | Auto-badge |
|---|---|---|---|
| Primitive types (string, number, boolean, null, undefined) | `language/types, language/literals` | 612/647 | **full ✓** |
| Operators (arithmetic, comparison, logical, bitwise) | `language/expressions/addition, language/expressions/subtraction …(+33)` | 849/1083 | **partial ⚠** |
| typeof / instanceof | `language/expressions/typeof, language/expressions/instanceof` | 33/59 | **partial ⚠** |
| delete operator | `language/expressions/delete` | 38/69 | **partial ⚠** |
| Comma operator | `language/expressions/comma` | 5/6 | **partial ⚠** |
| Labeled statements (break / continue) | `language/statements/labeled` | 19/24 | **partial ⚠** |
| for-in | `language/statements/for-in` | 77/115 | **partial ⚠** |
| arguments object (full) | `language/arguments-object` | 79/263 | **partial ⚠** |
| eval() | `language/eval-code, built-ins/eval` | 249/357 | **partial ⚠** |
| with statement | `language/statements/with, annexB/language/statements/with` | 16/181 | **partial ⚠** |
| Variables (var, let, const) | `language/statements/let, language/statements/const …(+2)` | 447/604 | **partial ⚠** |
| Functions & closures | `language/statements/function, language/function-code …(+1)` | 642/1177 | **partial ⚠** |
| Control flow | `language/statements/if, language/statements/switch …(+6)` | 481/699 | **partial ⚠** |
| try / catch / finally | `language/statements/try` | 108/201 | **partial ⚠** |
| throw | `language/statements/throw` | 14/14 | **full ✓** |
| Objects | `language/expressions/object, built-ins/Object` | 2678/4581 | **partial ⚠** |
| Strings | `built-ins/String, built-ins/StringIteratorPrototype` | 800/1230 | **partial ⚠** |
| Numbers | `built-ins/Number, built-ins/Math` | 623/665 | **full ✓** |
| JSON | `built-ins/JSON` | 87/165 | **partial ⚠** |
| Error types | `built-ins/Error, built-ins/NativeErrors …(+2)` | 120/199 | **partial ⚠** |
| Arrays | `built-ins/Array, built-ins/ArrayIteratorPrototype …(+1)` | 1452/3160 | **partial ⚠** |
| Regular expressions | `built-ins/RegExp, built-ins/RegExpStringIteratorPrototype` | 1549/1896 | **partial ⚠** |
| Property accessors (get / set) | `language/expressions/property-accessors` | 15/21 | **partial ⚠** |
| Arrow functions | `language/expressions/arrow-function, language/expressions/async-arrow-function` | 282/403 | **partial ⚠** |
| Template literals | `language/expressions/template-literal, language/expressions/tagged-template` | 39/84 | **partial ⚠** |
| Destructuring | `language/destructuring` | 16/19 | **partial ⚠** |
| Spread / rest operators | `language/rest-parameters` | 3/11 | **partial ⚠** |
| Computed property names | `language/computed-property-names` | 16/48 | **partial ⚠** |
| for-of | `language/statements/for-of` | 366/751 | **partial ⚠** |
| Generators (function*, yield) | `language/statements/generators, language/expressions/generators …(+3)` | 390/703 | **partial ⚠** |
| Classes | `language/expressions/class, language/statements/class …(+3)` | 6025/8593 | **partial ⚠** |
| Symbol | `built-ins/Symbol` | 52/98 | **partial ⚠** |
| Modules (import / export) | `language/module-code, language/import …(+1)` | 365/766 | **partial ⚠** |
| Proxy / Reflect | `built-ins/Proxy, built-ins/Reflect` | 137/464 | **partial ⚠** |
| Promise .then / .catch / .finally | `built-ins/Promise` | 468/652 | **partial ⚠** |
| SharedArrayBuffer / Atomics | `built-ins/SharedArrayBuffer, built-ins/Atomics` | 157/486 | **partial ⚠** |
| Async iteration (for-await-of) | `built-ins/AsyncGeneratorFunction, built-ins/AsyncGeneratorPrototype …(+4)` | 750/1046 | **partial ⚠** |
| Optional chaining (?.) | `language/expressions/optional-chaining` | 18/38 | **partial ⚠** |
| Nullish coalescing (??) | `language/expressions/coalesce` | 20/24 | **partial ⚠** |
| globalThis | `built-ins/global, built-ins/globalThis` | 19/29 | **partial ⚠** |
| BigInt | `built-ins/BigInt` | 30/77 | **partial ⚠** |
| Dynamic import() | `language/expressions/dynamic-import` | 563/939 | **partial ⚠** |
| WeakRef / FinalizationRegistry | `built-ins/WeakRef, built-ins/FinalizationRegistry` | 36/76 | **partial ⚠** |
| Exponentiation operator (**) | `language/expressions/exponentiation` | 36/44 | **partial ⚠** |
| Hashbang (#!) comments | `language/comments/hashbang, language/source-text` | 23/30 | **partial ⚠** |
| Iterator helpers (map, filter, take) | `built-ins/Iterator` | 221/510 | **partial ⚠** |
| String.prototype.substr | `annexB/built-ins/String/prototype/substr` | 14/15 | **full ✓** |
| escape() / unescape() | `annexB/built-ins/escape, annexB/built-ins/unescape` | 6/35 | **partial ⚠** |
| HTML string methods (.bold(), .anchor()) | `annexB/built-ins/String/prototype/anchor, annexB/built-ins/String/prototype/big …(+11)` | 81/82 | **full ✓** |
| RegExp.$1 static properties | `annexB/built-ins/RegExp/legacy-accessors` | 6/24 | **partial ⚠** |
| Temporal | `built-ins/Temporal` | 1221/4524 | **partial ⚠** |

### B. No measurable test262 data — static badge kept + flagged (26 features)

| Feature card | test262 category | Badge |
|---|---|---|
| Object.defineProperty (full) | `built-ins/Object/defineProperty` | static (kept) |
| Default parameters | `language/statements/function/default-parameter` | static (kept) |
| Object.entries / values | `built-ins/Object/entries, built-ins/Object/values` | static (kept) |
| Object spread / rest | `language/expressions/object/spread` | static (kept) |
| Class fields (public, private, static) | `language/statements/class/fields` | static (kept) |
| Error.cause | `built-ins/Error/cause` | static (kept) |
| Array.at / String.at | `built-ins/Array/prototype/at, built-ins/String/prototype/at` | static (kept) |
| Top-level await | `language/module-code/top-level-await` | static (kept) |
| Array.prototype.includes | `built-ins/Array/prototype/includes` | static (kept) |
| Optional catch binding | `language/statements/try/optional-catch-binding` | static (kept) |
| Array.prototype.flat / flatMap | `built-ins/Array/prototype/flat, built-ins/Array/prototype/flatMap` | static (kept) |
| Object.fromEntries | `built-ins/Object/fromEntries` | static (kept) |
| Array.findLast / findLastIndex | `built-ins/Array/prototype/findLast, built-ins/Array/prototype/findLastIndex` | static (kept) |
| Change array by copy (toSorted, toReversed, toSpliced) | `built-ins/Array/prototype/toSorted, built-ins/Array/prototype/toReversed …(+1)` | static (kept) |
| Promise.withResolvers | `built-ins/Promise/withResolvers` | static (kept) |
| Resizable ArrayBuffer | `built-ins/ArrayBuffer/prototype/resize` | static (kept) |
| RegExp v flag | `built-ins/RegExp/unicodeSets` | static (kept) |
| Set methods (union, intersection, difference) | `built-ins/Set/prototype/union, built-ins/Set/prototype/intersection …(+5)` | static (kept) |
| RegExp duplicate named groups | `built-ins/RegExp/named-groups` | static (kept) |
| var hoisting | `language/statements/variable, language/statements/var` | static (kept) |
| arguments.callee | `language/arguments-object/callee` | static (kept) |
| __proto__ accessor | `annexB/language/expressions/object/__proto__` | static (kept) |
| Octal literals (0777) | `annexB/language/literals/numeric` | static (kept) |
| Function.prototype.caller | `annexB/built-ins/Function/prototype/caller` | static (kept) |
| Decorators | _(none)_ | static (kept) |
| Pattern matching | _(none)_ | static (kept) |


### Audit notes — the 26 "no test262 data" rows

All 26 are flagged (not silently mislabelled). Two distinct reasons:

- **Absorbed by a broader parent bucket (first-match-wins).** Narrow features
  listed AFTER their parent in `feature-test-categories.json` get `0/0` because
  the parent already consumed their tests: e.g. `Object.defineProperty (full)`,
  `Object.entries / values`, `Object spread / rest` (parent `Objects` →
  `built-ins/Object`); `Array.prototype.includes`, `Array.at`,
  `Array.prototype.flat/flatMap`, `findLast/findLastIndex`, change-array-by-copy
  (parent `Arrays` → `built-ins/Array`); `var hoisting`, `arguments.callee`,
  `Default parameters`, `Optional catch binding`, `Class fields` (parents
  `Variables` / `arguments object` / `Functions` / `try` / `Classes`). These
  are NOT "no support" — the support is counted under the parent row. Keeping
  the curated static badge is the most accurate available signal; a future
  refinement could reorder the map to give them dedicated buckets.
- **Genuinely no test262 shard in the baseline** — TC39 proposals / late
  features not in the current-standard baseline: `Top-level await`,
  `Resizable ArrayBuffer`, `RegExp v flag`, `Promise.withResolvers`,
  `Set methods`, `RegExp duplicate named groups`, `Error.cause`,
  `Object.fromEntries`, `__proto__ accessor`, `Octal literals`,
  `Function.prototype.caller`. Static badge kept until a shard exists.
- **No mapped category at all (2)** — `Decorators` and `Pattern matching` have
  an empty `testCategories: []` (no stage-4 test262 path); they keep their
  static `✗` badge and are the only rows without an injected `data-t262-paths`.

### Files changed

- `scripts/derive-feature-badges.mjs` — rewritten: name-match against
  feature-examples.json, derive badge, inject `data-t262-paths`, `--check`.
- `scripts/feature-test-categories.json` — NEW shared name→category map.
- `website/dashboard/build-data.js` — import the shared map (behaviour-identical).
- `website/index.html` — `hydrateFeatureBadges()` overlay; 29 badges re-baked +
  63 `data-t262-paths` injected; hardcoded status strings removed; host-toggle
  re-cache hook.
- `.github/workflows/{ci.yml,test262-sharded.yml}` — comments updated to the new
  source of truth.
