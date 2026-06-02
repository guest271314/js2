---
id: 1650
title: "Component Model string boundary: encode-import selection (Edge B) on the encoding annotation"
status: backlog
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: hard
task_type: feature
area: compiler
language_feature: strings
goal: platform
sprint: Backlog
depends_on: [1588]
es_edition: multi
---
# #1650 — Component Model string boundary: encode-import selection (Edge B)

Follow-up to **#1588** (string encoding tracking). #1588 PR-C delivered the
standalone pure-Wasm `__str_to_utf8` transcoder (the missing primitive) plus a
throughput benchmark and ADR-0015. This issue carries the **deferred** half of
the original PR-C scope: wiring the `encoding` annotation into the
Component-Model string boundary so the proven-UTF-8 fast path is actually
selected at lowering time.

## Why this was deferred

The original PR-C plan (issue #1588, "## Phase 2 ABI Plan", §2 Edge B) presumed
a **CM-boundary encode-import infrastructure that does not exist yet**:

- There is **no Component-Model adapter for the WasmGC (`nativeStrings`)
  backend**. Edge B selects between a checked host `string_to_utf8` import and
  an unchecked `string_to_utf8_unchecked` import based on the annotation — but
  neither import is declared, and there is no boundary-lowering pass on the
  WasmGC side that would emit a call to either. The WasmGC backend stores
  strings as opaque `externref` (host-owned) or in-heap `NativeString`/
  `Utf8String`; crossing to a Component requires host glue (or the
  `wasm:js-string`/stringref `encode` builtins) that is not plumbed.
- The annotation is **not threaded into any lowering resolver** for the host
  edge (it reaches the storage-width decision in PR-B, but no boundary code
  reads it).
- The canonical-ABI lifetime/`realloc`/`post-return` contract for handing the
  CM a pointer into `Utf8String.data` is unspecified for this backend.

Building that adapter is a substantial, separable piece of work — it is the
infrastructure gap, not a small wiring change. #1588 PR-C therefore shipped the
**transcode kernel** (`__str_to_utf8`) that this work will call, and deferred
the boundary integration here.

## Scope

1. **Edge A (linear / WASI / canonical ABI, `src/codegen-linear/c-abi.ts`).**
   Read the arg's `Encoding` (plumbed from the IR value's `alloc` annotation)
   in the per-arg `case "string"` marshalling arms of `emitCabiWrappers`. For
   `utf8-guaranteed`/`ascii`: skip the WTF-16→UTF-8 re-encode and the
   surrogate-validity scan, lowering directly to `(ptr, byteLen)`. For `wtf16`
   or unknown: keep the existing scan-and-encode path. (Edge A is the closer of
   the two — the linear backend's strings are already byte-oriented, so the win
   is scan elision, not a copy.)

2. **Edge B (WasmGC / host edge, `src/codegen/declarations.ts`).** Declare the
   `string_to_utf8` (checked) and `string_to_utf8_unchecked` host imports next
   to the existing string imports, plus the **standalone Wasm-native fallback**
   that calls `__str_to_utf8` (delivered by #1588 PR-C) so the boundary works
   with no JS runtime ("JS host optional" rule). Select the import/fallback on
   the annotation at the boundary callsite.

3. **Plumb `allocRegistry` into the boundary lowering** the same way PR-B
   threaded it into the storage-width decision (`src/ir/integration.ts` →
   `IrLowerResolver` → `CodegenContext`).

4. **Alias-fusion soundness guard** (ADR-0015 / issue #1588 §4): before any CSE
   pass may fuse string sites, enforce that a `wtf16` site never aliases into a
   `utf8` canonical. No string-fusing pass exists today, so this is a forward
   guard; it must land before the boundary fast path is enabled.

5. **End-to-end benchmark**: string-heavy CM interop (literal/JSON/decoder
   origins through an exported function) measuring the scan+transcode baseline
   vs the fast path. The #1588 PR-C benchmark measured the transcode *kernel*
   in isolation; this measures the full boundary.

## Acceptance criteria

- [ ] Edge A scan elision implemented in `c-abi.ts`, keyed on the annotation;
      both paths exercised by tests.
- [ ] Edge B import selection + standalone `__str_to_utf8` fallback implemented;
      both paths exercised by tests.
- [ ] Differential test with fuzzed inputs incl. lone surrogates confirms the
      fast path is **never** selected for a surrogate-bearing value (soundness
      anchor).
- [ ] Alias-fusion guard in place.
- [ ] End-to-end CM-boundary benchmark numbers recorded in ADR-0015.
- [ ] Gated behind `--utf8-storage` (default off); byte-identical when off.

## References

- #1588 — string encoding tracking (parent; PR-C delivered `__str_to_utf8`).
- `docs/adr/0015-string-encoding-tracking.md` — lattice, rules, boundary design,
  PR-C status, Edge A/B split.
- #1588 issue "## Phase 2 ABI Plan" §2 — full Edge A / Edge B design with
  file:line targets.
- Component Model canonical ABI (string lifting/lowering, realloc/post-return).
