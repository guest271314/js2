# Dogfood harnesses — pinned real-package differential testing

Committed, reproducible harnesses that compile a real, pinned npm package
with js2wasm, validate the resulting Wasm, run it, and differentially diff
its output against the SAME package running natively under Node (zero
version skew — any divergence is a compiler bug, never an oracle mismatch).
Distinct from the broader `compileProject`-based `npm-library-support` goal
(lodash, axios, react, hono, eslint, prettier, ...): these harnesses
specifically target a **single pre-bundled dist file**, so there's no
multi-file module-resolution graph in the way of isolating compiler bugs.

Two packages so far:

| package | issue | entry file | oracle diff |
| --- | --- | --- | --- |
| **acorn** (JS parser) | #1710 | `dist/acorn.mjs` | structural AST diff (`ast-diff.mjs`) |
| **marked** (Markdown→HTML) | #3716 | `lib/marked.esm.js` | plain string equality (HTML output) |

## acorn (#1710)

Mechanizes the acorn self-hosting dogfood loop: **compile acorn with
js2wasm → validate the Wasm → run it → differentially diff its AST against
node-acorn**. It turns the previously throwaway `.tmp/acorn/probe.mjs`
scratch work into data that #1711 (triage) buckets and that #1712
(acceptance gate) reuses.

## Invoke

```bash
pnpm run dogfood:acorn          # run the loop, print a human summary, write the JSON report
npx tsx tests/dogfood/acorn-harness.mjs --json   # machine output to stdout
pnpm test -- tests/dogfood/acorn.test.ts         # vitest contract wrapper
```

The structured surface report is written to
`tests/dogfood/report/acorn-surface.json` (gitignored — regenerate any time).

## What it does

1. **Acquire** — `setup-acorn.mjs` verifies the pinned, committed acorn tarball
   (`fixtures/acorn-8.16.0.tgz`) against its canonical npm sha1 and extracts it
   into `tests/dogfood/.acorn/` (gitignored). **No run-time network.**
   Acquisition decision is pinned in `acorn-pin.json` per the project-lead
   decision (2026-05-29): pinned `npm pack`, not a vendored source copy.
2. **Compile** — feeds `dist/acorn.mjs` through `compile(src, { fileName:
   "acorn.mjs" })` and records `success`, binary size, and categorized
   diagnostics. The TS "Property does not exist" JS-noise (acorn is plain JS
   run through the TS checker) is collapsed into one non-blocking
   `ts-property-noise` bucket.
3. **Validate** — `WebAssembly.compile(binary)` and records the first validator
   error verbatim (the surface that exposed #1690).
4. **Run + diff** — when the binary validates and exposes a callable `parse`,
   parses each fixture in `fixtures/inputs/*.js` with both compiled-acorn and
   node-acorn (the **same pinned tarball** is the oracle, so any divergence is a
   compiler bug, never version skew) and structurally diffs the ASTs. A red
   surface (binary invalid) is **recorded and skipped**, never crashes the
   harness.
5. **Report** — emits `report/acorn-surface.json` +
   a human summary.

## Reusable differential-AST gate (`ast-diff.mjs`)

`diffAst(expected, actual, opts)` is the keystone shared with #1712. It does a
structural deep-compare of two acorn ASTs, **ignoring position fields**
(`start`/`end`/`loc`/`range`) by default so node-kind/shape/literal divergences
dominate the report; pass `{ ignorePositions: false }` to include them once
shape is clean. It reports the first divergence as
`{ path, reason, expected, actual }` with a JSONPath-ish pointer. `diffParse`
is a convenience that parses with both sides and diffs in one call.

The harness runs an **oracle self-check** (node-acorn vs node-acorn, identical
vs operator-differing sources) every run, proving `diffAst` detects both
equality and divergence even while compiled-acorn can't run yet — so #1712 can
rely on it immediately.

## Refreshing the pin

```bash
npm pack acorn@<version>            # produces acorn-<version>.tgz
# move it to tests/dogfood/fixtures/, update version/shasum/integrity in acorn-pin.json
npm view acorn@<version> dist.shasum dist.integrity   # canonical values to pin
```

The oracle dependency is the SAME tarball, so there is no separate `acorn`
devDependency to keep in sync.

## Scope (acorn)

This harness does **not** fix any compiler bug — pure tooling. Compiler defects
it surfaces are recorded in the report for #1711 to triage. Standalone
(`--target wasi`) execution of compiled acorn is an explicit follow-up
(a #1711 child), not part of this harness.

## marked (#3716)

Same loop, second package, deliberately simpler: marked's observable
surface is a single HTML **string** (not an AST object graph), so plain
string equality replaces `ast-diff.mjs`'s structural diff — no marshalling
layer needed to compare results.

```bash
pnpm run dogfood:marked          # run the loop, print a human summary, write the JSON report
npx tsx tests/dogfood/marked-harness.mjs --json   # machine output to stdout
DOGFOOD_MARKED=1 pnpm test -- tests/dogfood/marked.test.ts   # vitest contract wrapper
```

Report: `tests/dogfood/report/marked-surface.json` (gitignored). Pin:
`marked-pin.json` (same acquisition discipline as acorn — refresh via
`npm pack marked@<version>` + `npm view marked@<version> dist.shasum
dist.integrity`).

**Current state (first run, 2026-07-27)**: red surface — `marked` does not
compile at all yet. Root-caused to #3715 (TypeScript's "evolving array
type" inference — `let x = []` later populated via `.push()` — is not
implemented in the checker, so any array of this shape stays typed
`never[]` forever). This harness's job was to surface that, not fix it;
see #3715 for the minimal repro and scope. Once that lands, re-run
`pnpm run dogfood:marked` for the first real run+diff data.

This harness does **not** fix any compiler bug — pure tooling, same as
acorn's scope note above.
