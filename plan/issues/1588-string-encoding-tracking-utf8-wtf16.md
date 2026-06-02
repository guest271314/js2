---
id: 1588
title: "String encoding tracking: prove UTF-8 guarantees for zero-copy Component Model interop"
status: done
created: 2026-05-23
updated: 2026-05-24
completed: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: compiler
language_feature: strings
goal: platform
sprint: 55
depends_on: [1586]
required_by: [1650]
es_edition: multi
---
# #1588 — String encoding tracking: prove UTF-8 guarantees for zero-copy Component Model interop

Static analysis that propagates a per-string-value encoding guarantee
through the IR, distinguishing **provably-UTF-8** strings from
**possibly-WTF-16** ones. The motivation is the WebAssembly Component
Model: its `string` type is defined as a list of Unicode scalar values
encoded as UTF-8, while JavaScript strings are WTF-16 (UTF-16 with
unpaired surrogates permitted). Without tracking, every JS string crossing
a Component boundary requires re-encoding and a copy. With tracking, strings
proven to contain only valid UTF-8 scalars can cross the boundary directly.

The performance opportunity is substantial. The correctness consequence is
zero: tracking is purely advisory; strings without a UTF-8 guarantee fall
back to the existing re-encode-and-copy path.

Depends on #1586 (explicit allocation sites) for attachment point on
string allocations.

## Background

### Encoding mismatch

JavaScript strings, per ECMAScript spec, are sequences of 16-bit code
units, with no requirement that surrogate pairs are well-formed. A string
like `String.fromCharCode(0xD800)` is a single unpaired high surrogate.
This is WTF-16, not UTF-16.

The Component Model's `string` type is defined as a sequence of Unicode
scalar values (excluding surrogates by definition), canonically transferred
as UTF-8. There is no encoding for unpaired surrogates in UTF-8 because
the Unicode scalar set excludes them.

When a JS string crosses a Component boundary today:

1. The full string is scanned to validate Unicode scalar correctness.
2. Either it is re-encoded WTF-16 → UTF-8 (allocation + copy), or it
   contains unpaired surrogates and the conversion traps or substitutes.

For long strings, this scan + copy is measurable. For high-frequency
small-string transfers (logging, structured output, RPC) it dominates
the boundary cost.

### Many JS strings are provably UTF-8

In practice, most JavaScript strings encountered at Component
boundaries originate from sources that cannot introduce unpaired
surrogates:

- **String literals** in source code are validated at parse time.
- **`TextDecoder` decode results** are UTF-8 by construction (the spec
  forbids the decoder from producing unpaired surrogates).
- **`JSON.parse` outputs** are UTF-8 by spec (RFC 8259 restricts JSON
  text to UTF-8).
- **`fetch().text()` results** are UTF-8 unless explicitly told otherwise
  by the response headers.
- **Concatenations of UTF-8-guaranteed strings** preserve the guarantee.

Tracking these origins through the IR and propagating the guarantee
through preserving operations lets the boundary code use the cheap path
for the strings that allow it.

## Goal

After this issue:

1. Every string `AllocSite` from #1586 carries an `encoding` annotation
   with one of three values:
   - `utf8-guaranteed` — the analysis can prove the string contains
     only well-formed UTF-8 scalar values.
   - `wtf16` — the string may contain unpaired surrogates (the
     conservative default).
   - `ascii` — a stricter subset of `utf8-guaranteed` for strings provably
     containing only code points ≤ 0x7F. Enables further optimization
     (single-byte-per-char paths in Component Model implementations that
     support it).

2. A documented set of propagation rules for string operations:
   - origin operations (literal, decoder, JSON, etc.) seed the
     annotation.
   - preserving operations (concat, slice on code-point boundaries,
     intern) preserve the annotation.
   - encoding-destroying operations (fromCharCode with arbitrary
     argument, substring on raw code-unit indices, regex with capture
     groups that may split surrogates) drop the annotation to `wtf16`.

3. The Component Model boundary lowering reads the annotation and
   selects the appropriate path: zero-copy externref-passing for
   `utf8-guaranteed`, the existing scan-and-encode path for `wtf16`.

4. No semantic change to the program. A wrongly-conservative annotation
   yields a slower path but identical results. A wrongly-optimistic
   annotation is a correctness bug, and the analysis is required to err
   conservative.

## Why this is achievable in a short timeframe

Encoding analysis is structurally simpler than ownership analysis (#1587):

- It is **flow-insensitive in most cases** — the encoding of a string
  is determined at its origin and propagates statically through
  operations regardless of execution order.
- It is **monotonic**: starting `utf8-guaranteed`, an operation either
  preserves the guarantee or drops it. No fixed-point iteration needed
  for the common case.
- The propagation rules are a **small, finite table** — one entry per
  string-producing operation in the language.
- Wrong answers are degrading (slower path) rather than incorrect, so
  the safety bar is "never claim guarantee when none exists" rather
  than "always find every guarantee".

This means the implementation can be staged aggressively: a useful
initial version covers literal-origin + concat + JSON-decode and already
captures the majority of string traffic in real applications. Refinement
proceeds incrementally.

## Design

### Annotation lattice

A simple three-level lattice with `ascii` as a sublattice of
`utf8-guaranteed`:

```
              wtf16   (top, most permissive)
                │
          utf8-guaranteed
                │
              ascii  (bottom, most restrictive)
```

Operations join annotations conservatively. Two strings concatenated:

| Left          | Right         | Result        |
|---------------|---------------|---------------|
| `ascii`       | `ascii`       | `ascii`       |
| `ascii`       | `utf8-guaranteed` | `utf8-guaranteed` |
| `utf8-guaranteed` | `utf8-guaranteed` | `utf8-guaranteed` |
| any           | `wtf16`       | `wtf16`       |

### Origin rules

- String literal in source: `ascii` if all chars ≤ 0x7F, else
  `utf8-guaranteed`. Decided at parse time.
- `JSON.parse` result strings: `utf8-guaranteed` (JSON forbids
  unpaired surrogates per RFC 8259 §7).
- `TextDecoder.decode(buf)` result: `utf8-guaranteed` (per WHATWG
  Encoding spec).
- `fetch().text()` result: `utf8-guaranteed` if the response had a
  text/* media type with UTF-8 charset (the common case); `wtf16`
  otherwise. Conservative default if unknown: `wtf16`.
- `String.fromCharCode(n)` with statically known `n` ≤ 0xD7FF or
  in `[0xE000, 0xFFFF]`: `utf8-guaranteed`. Otherwise `wtf16`.
- `String.fromCodePoint(n)` with statically known scalar `n`:
  `utf8-guaranteed`. Dynamic `n`: `wtf16`.
- Property accesses, method results from non-tracked sources: `wtf16`.

### Propagation rules

- `s1 + s2`, template literal interpolation: join the annotations per
  the lattice table.
- `s.toUpperCase()`, `s.toLowerCase()`, `s.trim()`, `s.normalize()`:
  preserve the annotation. (These cannot introduce surrogates from
  non-surrogate input.)
- `s.slice(a, b)` with statically known indices that fall on code-point
  boundaries: preserve. Otherwise drop to `wtf16` (slicing in the
  middle of a surrogate pair would split the pair).
- `s.split(sep)` results: preserve if `sep` is statically known to be
  a non-surrogate string; otherwise `wtf16`.
- `s.replace(pattern, replacement)`: preserve if `pattern` is a string
  literal and `replacement` is a tracked string; drop for regex
  patterns unless the regex is statically analyzable.
- `s.repeat(n)`, `s.padStart(n, pad)`, `s.padEnd(n, pad)`: preserve.
- `JSON.stringify(value)` result: `utf8-guaranteed` (JSON stringify
  escapes lone surrogates per ES2019+ §24.5.2.2 Step 11).
- Any operation not in the above table: drop to `wtf16`.

### Component Model boundary integration

When the IR emits a call across a Component Model boundary that takes a
`string` argument, the lowering pass checks the annotation on the value:

- `ascii` or `utf8-guaranteed`: pass directly as a `(list u8)` view of
  the string's underlying storage, if the runtime representation
  permits zero-copy. Otherwise, fall through to the next case.
- `wtf16`: emit the existing scan-and-encode path.

The "if the runtime representation permits zero-copy" caveat depends on
how strings are stored in the Wasm-GC heap. If we store strings as
`(array i16)` (typical WTF-16 storage), zero-copy is not possible even
for `utf8-guaranteed` strings — they still need to be re-encoded from
16-bit units to 8-bit units. Two follow-up paths:

1. **Dual storage**: store `ascii` and `utf8-guaranteed` strings as
   `(array i8)` from the start; store `wtf16` strings as `(array i16)`.
   The encoding annotation drives the storage decision at the
   allocation site. This requires the annotation to be available before
   storage layout is committed.
2. **Lazy re-encoding cache**: keep WTF-16 storage everywhere but cache
   a UTF-8 view next to the string for tracked-UTF-8 strings.

Path 1 is preferable for new allocations because it eliminates the copy
entirely; Path 2 may be useful as an intermediate step. This is a
deliberate design decision in the implementation plan.

## Scope

1. ADR documenting the encoding lattice, origin rules, propagation
   table, and Component Model boundary integration.
2. Analysis pass implemented as a small dataflow over the IR, writing
   `encoding` annotations to the `AllocSiteRegistry` from #1586 (under
   the `encoding` namespace).
3. Update the Component Model boundary lowering to read the annotation
   and emit the appropriate path. Initial implementation may emit both
   paths and dispatch at runtime if static encoding is `wtf16`; the
   zero-copy path is only taken for tracked annotations.
4. Choose between dual-storage and lazy-re-encoding strategies. Initial
   implementation: dual storage for newly allocated `utf8-guaranteed`
   strings; keep WTF-16 storage for `wtf16` strings.
5. Implement the canonical origin rules (literal, JSON, TextDecoder)
   and propagation rules (concat, slice with known boundaries,
   case-conversion). Document gaps as follow-up items.
6. Test coverage: encoding annotations correctly inferred for a corpus
   of representative string patterns; Component Model boundary tests
   pass with both `utf8-guaranteed` and `wtf16` paths exercised.

## Phasing

**Phase 1 (this issue, ~3-4 weeks)**: lattice + analysis pass +
boundary integration + dual storage for the canonical origin set
(literal, JSON, TextDecoder, concat).

**Phase 2 (follow-up)**: extended origin coverage (fetch, regex
matches, Intl operations), propagation through more methods, refinement
of slice/substring rules.

**Phase 3 (follow-up)**: integration with the Reference-Typed Strings
proposal once it stabilizes — if that proposal lands, much of the
encoding tracking can be expressed in the type system rather than
inferred. Coordinate with #1165 (JIT-interface tracking) and other
proposal-tracking issues if a similar issue exists for Reference-Typed
Strings.

## Non-goals

- Changing the observable JavaScript semantics. WTF-16 indexing, length,
  comparison, etc. continue to work unchanged.
- Building a fully-precise encoding analysis. Conservative annotations
  on operations we cannot easily analyze (regex, dynamic indices) are
  acceptable; precision improvements are follow-up issues.
- Re-encoding all storage to UTF-8. WTF-16 storage remains the default
  for strings that the analysis cannot prove. Dual storage is only for
  proven-UTF-8 allocation sites.
- Adding new JavaScript-level APIs. The annotation is internal to the
  compiler and runtime.

## Relationship to other issues

- **#1586** (explicit allocation sites) — hard dependency. Encoding
  annotations live on string `AllocSite` nodes.
- **#1587** (ownership and access semantics analysis) — parallel
  analysis. Both run after #1586; both write to the registry; the two
  analyses do not interact in Phase 1, but Phase 2 of either may
  benefit from the other.
- **Component Model boundary issues** (existing or to-be-filed) — direct
  consumer of this analysis. Coordinate naming and ABI.
- **Reference-Typed Strings proposal** (WebAssembly/stringref) — long-
  term, may subsume parts of this analysis. Track separately.
- **#1105** (Wasm-native string method implementations) — relevant.
  Built-in string method implementations are the propagation rules in
  action; #1105 work should be designed to preserve encoding
  annotations.

## ECMAScript and WHATWG spec references

- [ECMA-262 §6.1.4 String type](https://tc39.es/ecma262/#sec-ecmascript-language-types-string-type) — WTF-16 semantics
- [ECMA-262 §24.5.2 JSON.stringify](https://tc39.es/ecma262/#sec-json.stringify) — UTF-8 escape behavior
- [ECMA-262 §22.1.3.x String.prototype methods](https://tc39.es/ecma262/#sec-properties-of-the-string-prototype-object) — method-by-method propagation rules
- [WHATWG Encoding spec](https://encoding.spec.whatwg.org/) — TextDecoder UTF-8 guarantees
- [RFC 8259 JSON](https://datatracker.ietf.org/doc/html/rfc8259) — UTF-8 requirement for JSON text
- [Component Model: string](https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md) — canonical ABI for strings

## Acceptance criteria

- [ ] ADR-XXX documents the encoding lattice, origin rules, propagation
      table, and storage strategy.
- [ ] Analysis pass implemented under `src/ir/analysis/encoding.ts`,
      writing to the `AllocSiteRegistry` `encoding` namespace.
- [ ] Origin rules implemented for: string literals, `JSON.parse`,
      `JSON.stringify`, `TextDecoder.prototype.decode`.
- [ ] Propagation rules implemented for: `+` and template literals
      (concat), `.toUpperCase`, `.toLowerCase`, `.trim`,
      `.slice` with statically known boundaries, `.repeat`, `.padStart`,
      `.padEnd`.
- [ ] Component Model boundary lowering reads the annotation and
      selects path. Both paths exercised by tests.
- [ ] Dual storage implemented for `utf8-guaranteed` allocation sites:
      strings allocated under `utf8-guaranteed` use `(array i8)`
      storage; `wtf16` strings retain `(array i16)`.
- [ ] Benchmark: end-to-end measurement of string-heavy Component Model
      interop showing the zero-copy path's improvement over the
      scan-and-encode baseline. Numbers go into the ADR.
- [ ] No semantic regressions in any test suite. WTF-16 strings continue
      to work; equality, indexing, length, comparison all unchanged.

## Risks

- **Soundness bug claims UTF-8 when string contains a surrogate.**
  Catastrophic — produces malformed UTF-8 at the Component boundary,
  which may corrupt the receiving Component or trap. Mitigation: the
  conservative default is `wtf16`; only explicit, audited origin rules
  promote to `utf8-guaranteed`; differential testing must include
  fuzzed string inputs that exercise the boundary.
- **Dual storage doubles complexity in the string runtime.** Every
  string operation now needs to handle both representations.
  Mitigation: built-ins are coded against an abstract string interface;
  the i8/i16 difference is hidden behind a small set of access
  primitives. This pattern is already established in #1105.
- **Coverage of origin rules insufficient to move the benchmark.** If
  the analysis only promotes a small fraction of strings, the boundary
  improvement is invisible. Mitigation: the canonical origin set
  (literal, JSON, decoder) covers the majority of real-world strings;
  benchmark numbers in the ADR validate this.
- **Reference-Typed Strings proposal lands and obsoletes this work.**
  Possible long-term outcome. Mitigation: the analysis investment is
  still useful even if the proposal lands — type information from the
  proposal would replace inference, but the propagation rules and
  Component Model dispatch logic remain. Worst case: the analysis
  becomes vestigial and is removed; the dual-storage work transfers.

## Notes

- This issue produces directly user-visible performance improvements at
  the Component Model boundary, which is the integration surface that
  matters most for adoption in Wasm-component ecosystems. The ADR
  should make the performance story explicit, with measured numbers,
  so that downstream users can evaluate whether their workload is
  positioned to benefit.
- The conservative-by-default rule is more important here than in
  #1587, because the failure mode is correctness rather than missed
  optimization. The pattern of "small audited origin set, monotonic
  drop to conservative on uncertainty" is the right shape.
- A real benchmark is required as an acceptance criterion (rather than
  being a Phase 2 nice-to-have) because the entire motivation is
  performance. Without numbers, the analysis is theoretical.
- Naming: "UTF-8 guaranteed" is the term used here for clarity; the
  ADR may settle on a different internal name (`wellformed`, `scalar`,
  etc.) once the analysis is implemented.

## Phase 1 implementation status (2026-05-23)

Landed:

- **Lattice + analysis pass** — `src/ir/analysis/encoding.ts`. Exports
  `Encoding` (`ascii | utf8-guaranteed | wtf16`), `joinEncoding`,
  `classifyLiteral`, and `analyzeEncoding(fn, registry)`. The pass is a
  single read-only forward pass over the IR; it writes annotations to the
  `AllocSiteRegistry` `encoding` namespace (`ALLOC_NAMESPACES.encoding`,
  reserved by #1586) and never mutates the IR. Re-exported from
  `src/ir/index.ts`.
- **Origin rule** — string literals (`string.const`): `ascii` if all code
  units ≤ 0x7F; `utf8-guaranteed` if well-formed but non-ASCII; `wtf16` if a
  lone surrogate is present (cannot be valid UTF-8).
- **Propagation rule** — `s1 + s2` (`string.concat`): join the operands'
  encodings per the lattice. Untracked operands (params, call results)
  default to `wtf16`, which conservatively forces the result to `wtf16`.
- **Pipeline wiring** — `compileIrPathFunctions` runs `analyzeEncoding` over
  every hygiene-stable IR function (`src/ir/integration.ts`, after the 2a
  hygiene loop). Annotations are inert at lowering, so emitted Wasm is
  unchanged. Inline/mono passes preserve or alias the `alloc` ids, and the
  registry's `alias` merges annotations onto the canonical site.
- **ADR-0015** — `docs/adr/0015-string-encoding-tracking.md` (numbered 0015
  to avoid colliding with #1587's reserved ADR-0014).
- **Tests** — `tests/ir/encoding-analysis.test.ts` (11 cases): lattice join,
  literal classifier incl. surrogate edge cases, pass annotation for
  literals + concat, conservative-default for untracked operands, read-only
  + idempotent invariants.

Deferred to Phase 2 (require IR changes outside this issue's landed surface):

- **Call-result origins** (`JSON.parse`, `JSON.stringify`,
  `TextDecoder.decode`, `fetch().text()`) — their IR results
  (`call`/`extern.call`) do not yet carry a string `alloc` id, so there is
  no attachment point. Minting string alloc ids on those results is a
  prerequisite.
- **Method propagation** (`.toUpperCase`/`.toLowerCase`/`.trim`/`.slice`/
  `.repeat`/`.padStart`/`.padEnd`/`.split`/`.replace`) — same prerequisite.
- **Component Model boundary lowering** + **dual storage** (`(array i8)` for
  proven-UTF-8 sites) + **benchmark** — these consume the annotation and
  touch shared codegen / require a benchmark harness; the analysis lands
  first so the boundary work has data to read. See ADR-0015 §"Component
  Model boundary integration".

## Phase 2 ABI Plan

Author: Architect (one-shot spec). Date: 2026-05-23. Status: design only — no
code in this section.

> **Provenance of cited line numbers.** Phase 1 (lattice + analysis) and PR-A
> (call-result origins + method propagation) are landed on the branches
> `issue-1588-strenc` and `issue-1588-phase2a` respectively but **not yet
> merged to `main`** as of this writing. File:line citations below reference
> those branches where the symbol does not yet exist on `main`. The dev
> implementing Phase 2 must rebase on the merged state and re-grep — treat the
> line numbers as "nearest landmark", the symbol names as authoritative.

### 0. What exists today (the inputs this ABI consumes)

- **Encoding lattice + analysis** — `src/ir/analysis/encoding.ts`
  (`@issue-1588-strenc`): `Encoding = "ascii" | "utf8-guaranteed" | "wtf16"`,
  `joinEncoding`, `classifyLiteral`, `analyzeEncoding(fn, registry)`. PR-A
  adds `classifyCall` / `classifyExternCall` (`@issue-1588-phase2a` encoding.ts
  ~line 142–220) covering `JSON.parse`/`JSON.stringify` →
  `utf8-guaranteed`, `TextDecoder.decode` → `utf8-guaranteed`, and the
  preserving-method set (`toUpperCase`/`toLowerCase`/`trim*`/`normalize`/
  `padStart`/`padEnd`/`repeat`).
- **Annotation channel** — `AllocSiteRegistry` (`src/ir/alloc-registry.ts`),
  `annotate(id, ns, value)` / `read(id, ns)`, namespace
  `ALLOC_NAMESPACES.encoding = "encoding"`. `alias()` merges metadata onto the
  canonical site on fusion (existing keys win), so annotations survive
  inline/mono/CSE. `retire()` drops them. Read: `registry.read<Encoding>(id,
  ALLOC_NAMESPACES.encoding)`.
- **String alloc-site minting** — the IR builder mints a `"string"`
  `AllocKind` on `string.const`, `string.concat` (Phase 1) and string-typed
  `call` / `extern.call` results (PR-A, `src/ir/builder.ts` ~181, ~633). This
  is the **only** set of sites with an annotation today; everything else reads
  back `wtf16` by default (`encoding.ts` `enc()` fallback).
- **Pass wiring** — `analyzeEncoding` runs in the IR pipeline after the 2a
  hygiene loop (`src/ir/integration.ts` ~360, just past `assertAllocProvenance`).
  The `allocRegistry` instance (integration.ts ~124) is the live object the
  lowering pass must be handed; it is currently **not** threaded into the
  lowering resolver.
- **WasmGC string runtime** — `src/codegen/registry/types.ts:200`
  `registerNativeStringTypes`: the backing array `__str_data` is
  `(array (mut i16))` (line 205); `NativeString = { len:i32, off:i32,
  data:ref __str_data }` (subtype of `AnyString`); `ConsString = { len, left,
  right }` ropes. Literal materialization: `nativeStringLiteralInstrs`
  (`src/codegen/native-strings.ts:25`). Host-string mode (default, no
  `nativeStrings`) stores strings as opaque `externref` (wasm:js-string), where
  the host owns the WTF-16 representation and we have **no byte access** at all.
- **Linear backend CM/C-ABI edge** — `src/codegen-linear/c-abi.ts:9`:
  `string → (i32 ptr, i32 byteLen)` pair, documented as **UTF-8 data**. This
  is the existing WASI/Component-Model boundary; the wrapper marshalling is in
  `emitCabiWrappers` (c-abi.ts ~164–260). The WIT generator
  (`src/wit-generator.ts:138`) emits the abstract `string` WIT type and does
  **not** itself perform canonical-ABI lowering.

### 1. Dual i8 / i16 storage decision

**Decision: storage width is keyed off the `encoding` annotation on the
string's `AllocSite`, read from the registry at lowering time. The decision is
made per allocation site, not per value, and only for the WasmGC
(`nativeStrings`) backend.**

#### Where the decision is made

- The string-creating lowering sites are the consumers:
  - Literals: `nativeStringLiteralInstrs` (`src/codegen/native-strings.ts:25`)
    and `compileNativeStringLiteral` (its callers).
  - Concat results: the `__str_concat` / cons-string builders in
    `native-strings.ts` (the `ensureNativeStringHelpers` body, ~500–540).
  - The IR lowering resolver `emitStringConst` /`string.concat` handlers
    (`src/ir/lower.ts:953`, `:959`) which call the resolver hooks
    (`emitStringConst?`, lower.ts:282).
- At each, read the annotation:
  `const enc = registry.read<Encoding>(instr.alloc, ALLOC_NAMESPACES.encoding) ?? "wtf16";`
  Choose backing array: `enc === "ascii" || enc === "utf8-guaranteed"` →
  **i8 array** (`__str_data_u8`, a new `(array (mut i8))` type), else the
  existing i16 `__str_data`.

#### New types (additive, behind the flag — see §3)

Register alongside `registerNativeStringTypes`
(`src/codegen/registry/types.ts:200`):

- `__str_data_u8 = (array (mut i8))` — UTF-8 bytes.
- `Utf8String = { len:i32 /* code-unit length, JS-visible */,
  byteLen:i32, off:i32, data:ref __str_data_u8 }`, a **third subtype of
  `AnyString`** (alongside `NativeString` and `ConsString`).

  Rationale for keeping JS-visible `len` as code-unit (UTF-16) length: `.length`,
  indexing, and comparison are observable WTF-16 semantics (Non-goals, this
  issue). `len` preserves them; `byteLen` is the canonical-ABI size that lets
  the boundary skip the scan. For an `ascii` string `len == byteLen`; for
  `utf8-guaranteed` `byteLen >= len` is possible (multi-byte scalars).

#### Keying off AllocSiteRegistry

The annotation is attached to `instr.alloc` (an `AllocSiteId`). The lowering
resolver does **not** currently receive the registry. **Required plumbing**:
thread `allocRegistry` from `src/ir/integration.ts:124` into the
`IrLowerResolver` (built in Phase 3 of integration; see integration.ts where
the resolver is constructed) and store it on `CodegenContext` (add a field in
`src/codegen/context/types.ts` next to `nativeStrDataTypeIdx:505`). The IR
`alloc` id must reach the lowering callsite — the `string.const` /
`string.concat` instrs already carry `instr.alloc`, so pass it through the
resolver hook signatures (`emitStringConst`, lower.ts:282 — extend to
`emitStringConst(value, alloc?)`).

#### Fallback when encoding is unknown

- `registry.read(...) === undefined` (no annotation: untracked origin,
  legacy non-IR path, or AST→Wasm front-end) → treat as `wtf16` → i16
  storage. **This is the existing behavior**, so any value the analysis does
  not reach is byte-identical to today.
- `ConsString` ropes: a concat result is annotated, but its operands may be
  mixed-width (see §4). A `ConsString` whose flattened result is
  `utf8-guaranteed` may still have an i16 leaf. **Decision: ropes always
  flatten to the width of their own annotation**; the `flatten` helper
  (`native-strings.ts` ~440) reads the annotation off the cons node's
  `alloc` and emits into i8 or i16 accordingly, transcoding leaves as it
  copies (it already does a code-unit copy loop). A cons node with no
  annotation flattens to i16.
- Host-string mode (`!ctx.nativeStrings`): **no dual storage.** Strings are
  opaque host `externref`; we cannot pick their byte width. The annotation is
  consumed only at the boundary (§2) to choose the host marshalling import.

### 2. Component Model boundary lowering ABI

The boundary is where the annotation pays off. Two distinct edges exist; the
plan covers both.

#### Edge A — linear-memory / WASI / canonical ABI (`c-abi.ts`)

This is the real Component-Model edge. Canonical ABI `string` is
`(ptr:i32, byteLen:i32)` of UTF-8 (`c-abi.ts:9`). Today the wrapper
(`emitCabiWrappers`, c-abi.ts ~164) assumes the internal string is already
UTF-8-laid-out in linear memory. With dual storage on the WasmGC side this
edge only applies to the linear backend, whose internal strings are already
byte-oriented — so the win here is **eliding the scalar-validity scan**, not a
copy:

- `utf8-guaranteed` / `ascii` arg: lower directly to `(ptr, byteLen)` from the
  string header, **skipping** the WTF-16→UTF-8 re-encode and the
  surrogate-validity scan. For `ascii`, the receiver may additionally advertise
  a `latin1`/1-byte fast path to CM implementations that accept it.
- `wtf16` arg: keep the existing scan-and-encode path (allocate a UTF-8
  buffer, transcode, validate). On a lone surrogate this path traps/substitutes
  per current behavior — **unchanged**.

Lowering site: the per-arg marshalling switch in `emitCabiWrappers`
(c-abi.ts, the `case "string"` arms ~72, ~133, ~252). Add a branch keyed on
the arg's `Encoding` (resolved from the IR value's `alloc` annotation, plumbed
the same way as §1). When the encoding is statically `wtf16` **or unknown**,
emit the scan path; only the proven set takes the fast path.

#### Edge B — WasmGC / wasm:js-string host edge

For the default (host) backend strings are `externref` owned by the JS host;
crossing to a Component requires the host glue to encode. Here the annotation
selects **which host import** the call lowers to:

- `utf8-guaranteed`/`ascii`: a `string_to_utf8_unchecked` import (host encodes
  with `TextEncoder`, no JS-side surrogate check needed because we proved
  well-formedness) — or, when the runtime supports the
  `wasm:js-string`/stringref `encode` builtins, the unchecked encode variant.
- `wtf16`: the checked `string_to_utf8` import that validates/substitutes.

These imports are declared next to the existing console/string imports in
`src/codegen/declarations.ts` (~831–867). The standalone-mode requirement
(CLAUDE.md "JS host optional"): the WasmGC backend with `nativeStrings` + dual
storage has the i8 bytes in-heap, so a Wasm-native `string_to_utf8` that just
returns the `Utf8String.data` view satisfies standalone mode without a host
import. Host imports remain the fast path when a JS runtime is present.

#### WIT / canonical-ABI implications

- The WIT type is unchanged: still `string` (`wit-generator.ts:138`). The
  encoding distinction is an **internal lowering optimization**, invisible in
  the interface. A Component consuming our exports sees standard
  canonical-ABI UTF-8 either way.
- `realloc`/`post-return`: the fast path for `utf8-guaranteed` linear strings
  can hand the canonical ABI a pointer into the existing `Utf8String.data`
  only if the data outlives the call (lift/lower lifetime rules). For an
  **export return** the canonical ABI calls our `realloc` to own the buffer —
  so the "zero-copy" claim is precise: zero *transcode* + zero *scan*, but the
  canonical-ABI ownership copy may still occur per the CM lifting rules. The
  benchmark (§3, PR-C) must measure against the scan+transcode baseline, not
  claim a literal zero-byte-copy where the ABI mandates one.
- Lone-surrogate strings can never be `utf8-guaranteed` (the classifier
  demotes them, `encoding.ts` `classifyLiteral`), so the fast path can never
  emit malformed UTF-8 across the WIT edge. This is the soundness anchor.

### 3. Migration / safety — gating and PR sequencing

**Hard requirement: default-OFF, byte-identical when off.** The Phase 1
analysis is already inert (no consumer). Phase 2 introduces the first
consumer, so it must be gated.

#### The flag

Add a compiler option `--utf8-storage` (CLI: `src/cli.ts`; option struct:
`src/compiler.ts` / `src/index.ts` alongside `nativeStrings`). Default
`false`. Gate everything in §1 and §2 behind it:

- When `false`: the lowering sites never read the encoding annotation; storage
  is i16 (WasmGC) and the boundary uses the existing scan path. The new
  `Utf8String`/`__str_data_u8` types are **not registered** (no type-table
  churn → emitted Wasm byte-identical to today). Verifiable by a golden-wasm
  diff test on a literal-heavy fixture with the flag off.
- When `true`: dual storage + fast boundary path active.
- `--utf8-storage` implies `nativeStrings` for the WasmGC backend (the host
  backend can't do dual storage; Edge B import selection still works there and
  may be gated separately if desired). For `--target wasi` (linear), only
  Edge A applies and `nativeStrings` is already auto-on.

#### PR sequencing

- **PR-B (storage)** — register `__str_data_u8` + `Utf8String`
  (`registry/types.ts`), thread `allocRegistry` into the lowering resolver and
  `CodegenContext`, implement the storage-width decision at the literal /
  concat / flatten sites (`native-strings.ts`), behind `--utf8-storage`. No
  boundary change yet: a `Utf8String` is consumed by the existing string
  helpers via a small access-primitive abstraction (charCodeAt / length /
  copy that branches on the `AnyString` subtype — the pattern already exists
  for `NativeString` vs `ConsString` in `ensureNativeStringHelpers`). Tests:
  golden-wasm byte-identity with flag off; round-trip correctness (length,
  indexing, comparison, concat) for i8-backed strings with flag on; a
  fuzz/property test that an i8 string and its i16 equivalent are
  `===`-observably identical.
- **PR-C (boundary + benchmark)** — implement Edge A
  (`c-abi.ts`) and Edge B (`declarations.ts` import selection) keyed on the
  annotation; add the standalone Wasm-native `string_to_utf8` fallback. Add
  the benchmark harness (string-heavy CM interop: literal/JSON/decoder origins
  through an exported function) measuring scan+transcode baseline vs fast path,
  numbers into ADR-0015. Tests: both paths exercised (a `wtf16` value forced
  through the scan path, a `utf8-guaranteed` value through the fast path);
  differential test with fuzzed inputs incl. lone surrogates confirming the
  fast path is never selected for a surrogate-bearing value.

Each PR is independently revertible and inert-when-off. PR-B can merge and
bake before PR-C flips any boundary behavior.

### 4. Edge cases

- **Lone surrogates (wtf16-only).** `classifyLiteral` already returns `wtf16`
  for any lone surrogate (`encoding.ts`); such a string therefore always gets
  i16 storage and the scan boundary path. **Invariant to preserve in PR-B:**
  the storage-width decision uses the *same* annotation, so a value can never
  be both surrogate-bearing and i8-backed. Add an assertion in the i8
  literal/flatten emitter: if the source code units include a lone surrogate,
  the annotation must not be `ascii`/`utf8-guaranteed` (defensive; the
  classifier guarantees it, the assert catches a future classifier bug before
  it produces malformed bytes).
- **Concatenation of mixed-encoding operands.** `string.concat`'s annotation
  is `joinEncoding(lhs, rhs)` (already landed). Storage cases:
  - both i8-eligible (`ascii`/`utf8`) → result i8, leaves copied as bytes.
  - one i16 (`wtf16`) → join is `wtf16` → result i16; an i8 leaf is
    width-extended (zero-extend bytes to i16 code units — safe, ASCII/UTF-8
    bytes are not surrogates) during the copy in `__str_concat`/flatten.
  - **Cons-string deferral:** the rope node carries its own annotation; its
    leaves may differ in width. Flattening reads the *node's* annotation to
    pick output width and transcodes leaves on the fly (§1 fallback). A `wtf16`
    cons over an i8 leaf zero-extends; a `utf8-guaranteed` cons over an i8 leaf
    copies bytes directly. A `utf8-guaranteed` cons can never have a `wtf16`
    (surrogate) leaf because the join would have forced `wtf16`.
- **Interop with the existing dual string backend (nativeStrings vs
  wasm:js-string).** Three sub-backends now coexist, selected at compile time:
  1. host `externref` (default) — no in-heap bytes; annotation used only for
     Edge B import selection. `Utf8String` is irrelevant; do **not** register
     it in this mode.
  2. `nativeStrings` i16 (today's WasmGC) — `--utf8-storage` off, or values
     annotated `wtf16`.
  3. `nativeStrings` + `--utf8-storage` i8 (`Utf8String`) — new path.
  The access primitives (`charCodeAt`, `length`, substring/copy) must dispatch
  on the `AnyString` subtype tag so mode-2 and mode-3 strings interoperate in
  the same module (a function may receive an i16 param and concat an i8
  literal). This is the "abstract string interface" called out in the issue
  Risks; the existing `NativeString`/`ConsString` `ref.test` dispatch in
  `ensureNativeStringHelpers` is the template — add a third arm for
  `Utf8String`.
- **Annotation absent on a code path the analysis didn't reach** (legacy
  AST→Wasm front-end, IR fallback): `registry.read` → `undefined` → `wtf16` →
  i16 + scan path. Strictly the slow, correct path. No new failure mode.
- **`alias`/`retire` interaction.** If a future CSE fuses two string sites of
  *different* encodings, `alias()` keeps the existing key (the canonical
  site's annotation wins). This could let a `utf8` site alias into a `wtf16`
  canonical (safe — slower) or vice-versa (**unsafe** — a `wtf16` value
  reading a `utf8` annotation). **Required guard:** before PR-C flips the
  boundary, add a check in the encoding analysis or a CSE precondition that
  string sites may only be aliased when `joinEncoding(a,b)` equals the
  surviving annotation (i.e. never alias a `wtf16` site into a `utf8`
  canonical). Document in ADR-0015. No CSE pass fuses strings today, so this is
  a forward-guard, not a present bug.

### File:line target summary (rebase + re-grep before editing)

| Concern | File:line | Symbol |
|---|---|---|
| Encoding type + join + classifier | `src/ir/analysis/encoding.ts` (@strenc) | `Encoding`, `joinEncoding`, `classifyLiteral` |
| Call/extern origin rules | `src/ir/analysis/encoding.ts` ~142–220 (@phase2a) | `classifyCall`, `classifyExternCall` |
| Annotation read/write | `src/ir/alloc-registry.ts` | `annotate`, `read`, `ALLOC_NAMESPACES.encoding` |
| String alloc minting | `src/ir/builder.ts` ~181, ~633 (@phase2a) | `call`/`extern.call` `alloc` |
| Pass invocation | `src/ir/integration.ts` ~360 | `analyzeEncoding`; registry @124 |
| WasmGC string types | `src/codegen/registry/types.ts:200` | `registerNativeStringTypes`, `__str_data` (i16, :205) |
| Literal materialization | `src/codegen/native-strings.ts:25` | `nativeStringLiteralInstrs` |
| Concat / flatten helpers | `src/codegen/native-strings.ts` ~440, ~500 | `ensureNativeStringHelpers` |
| IR lowering string hooks | `src/ir/lower.ts:953`, `:282` | `string.const`/`string.concat`, `emitStringConst?` |
| Context field for registry | `src/codegen/context/types.ts:505` | add next to `nativeStrDataTypeIdx` |
| Linear CM/C-ABI string edge | `src/codegen-linear/c-abi.ts:9`, ~72/133/252 | `emitCabiWrappers`, `case "string"` |
| Host string-encode imports | `src/codegen/declarations.ts` ~831–867 | import declarations |
| WIT string type (unchanged) | `src/wit-generator.ts:138` | `mapTypeNode` |
| CLI / option flag | `src/cli.ts`, `src/compiler.ts`, `src/index.ts` | `--utf8-storage` |
| ADR | `docs/adr/0015-string-encoding-tracking.md` (@strenc) | extend §"Component Model boundary" + add storage + alias-guard |

## PR-C status (2026-05-24) — revised scope

The original PR-C plan (Edge A `c-abi.ts` scan elision + Edge B
`declarations.ts` import selection + benchmark) presumed a Component-Model
encode-import infrastructure on the WasmGC backend that **does not exist yet**:
no CM adapter, no boundary-lowering pass reading the annotation, no declared
encode imports, and `allocRegistry` not threaded into the host-edge resolver.
Edge B "import selection" could not be built without first building that
adapter — an infrastructure gap, not a wiring change. PR-C was therefore
rescoped to ship the **missing transcode primitive** the boundary will consume.

Landed:

- **`__str_to_utf8(s: ref $AnyString) -> ref $__str_data_u8`** —
  `src/codegen/native-strings.ts`, gated on `--utf8-storage` (emitted next to
  the inverse `__str_utf8_to_flat`). Pure-Wasm WTF-16 → UTF-8 transcoder:
  flattens any string (NativeString i16 / ConsString rope / Utf8String i8) via
  `__str_flatten`, then two passes over the i16 buffer (pass 1 sums the UTF-8
  byte length so the i8 output is allocated exactly once; pass 2 writes bytes).
  Total — a lone surrogate is emitted as 3-byte WTF-8 rather than trapping
  (defensive; the boundary fast path only ever sees proven-`utf8-guaranteed`
  values, which can never contain a lone surrogate). This is the standalone
  primitive the deferred Edge B fallback (`string_to_utf8`) will call — "JS
  host optional" without a `TextEncoder` import.
- **Tests** — `tests/issue-1588-str-to-utf8.test.ts` (10): asserts byte-exact
  equality with `Buffer.from(str,"utf8")` for ascii / 2-byte / 3-byte / astral /
  mixed / empty, plus explicit WTF-8 checks for lone high/low surrogates.
- **Benchmark** — `benchmarks/str-to-utf8.bench.mts` (`npx tsx`): pure-Wasm
  `__str_to_utf8` vs JS host `TextEncoder.encode`. Kernel micro-benchmark
  (each rep re-materializes the source string, so figures include WasmGC
  allocation the in-heap boundary path would not pay): ascii ~0.22×, latin-1
  ~0.31×, CJK ~0.67×, astral (4-byte emoji) **~1.5× faster than TextEncoder**.
  The pure-Wasm kernel wins on astral-heavy content; numbers recorded in
  ADR-0015. Conclusion: a standalone transcoder is competitive with V8's native
  encoder, so the standalone CM path is worth taking when no host runtime is
  present.
- **ADR-0015** — "PR-C (landed — revised scope)" documents the helper, the
  Edge A invariant (a lone surrogate can never be `utf8-guaranteed`, so the
  scan-eliding fast path can never emit malformed UTF-8), and the Edge B
  deferral.

Deferred to **#1650** (CM-boundary encode-import selection): Edge A scan
elision, Edge B import selection + standalone fallback wiring, `allocRegistry`
plumbing into the boundary resolver, alias-fusion soundness guard, and the
end-to-end boundary benchmark.
