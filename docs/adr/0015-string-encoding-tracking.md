# ADR-0015: String encoding tracking

Status: Accepted

## Context

JavaScript strings are WTF-16: sequences of 16-bit code units with no
requirement that surrogate pairs be well-formed (`String.fromCharCode(0xD800)`
is a single unpaired high surrogate). The WebAssembly Component Model `string`
type, by contrast, is a sequence of Unicode scalar values, canonically
transferred as UTF-8 — there is no UTF-8 encoding for an unpaired surrogate.

When a JS string crosses a Component boundary today it must be scanned for
scalar correctness and re-encoded WTF-16 → UTF-8, which allocates and copies.
For long strings, or high-frequency small-string transfers (logging, RPC,
structured output), this dominates the boundary cost.

In practice most strings at a boundary originate from sources that cannot
introduce unpaired surrogates (source literals, `JSON.parse`,
`TextDecoder.decode`, concatenations of such strings). If the compiler can
prove a string is well-formed UTF-8, the boundary can use a cheap path.

This builds on ADR-0013 (explicit allocation sites): encoding annotations are
attached to string `AllocSite`s via the registry's namespaced metadata channel.

## Decision

Introduce a static, advisory **encoding lattice** and a forward analysis pass
(`src/ir/analysis/encoding.ts`) that annotates string allocation sites in the
`AllocSiteRegistry` under the `encoding` namespace
(`ALLOC_NAMESPACES.encoding`). The analysis never mutates the IR and is inert
at lowering, so emitted Wasm is byte-identical whether or not it runs.

### Lattice

```
              wtf16            (top — most permissive, conservative default)
                │
          utf8-guaranteed
                │
              ascii            (bottom — strongest claim, code points ≤ 0x7F)
```

`ascii ⊑ utf8-guaranteed ⊑ wtf16`. The join (least upper bound) is the
conservative combination: any operand `wtf16` forces `wtf16`; otherwise
`utf8-guaranteed`, unless both operands are `ascii` (then `ascii`).

| Left            | Right             | Result            |
|-----------------|-------------------|-------------------|
| `ascii`         | `ascii`           | `ascii`           |
| `ascii`         | `utf8-guaranteed` | `utf8-guaranteed` |
| `utf8-guaranteed` | `utf8-guaranteed` | `utf8-guaranteed` |
| any             | `wtf16`           | `wtf16`           |

### Origin rules (Phase 1)

- **String literal**: classify by code units — `ascii` if all units ≤ 0x7F;
  else `utf8-guaranteed` if no lone surrogate; else `wtf16` (a literal
  containing a lone surrogate, e.g. via an escape, cannot be valid UTF-8).

Phase 2 origins (deferred — see below): `JSON.parse` (UTF-8 per RFC 8259),
`JSON.stringify` (escapes lone surrogates per ES2019+ §24.5.2.2),
`TextDecoder.decode` (UTF-8 per WHATWG Encoding), `fetch().text()`.

### Propagation rules (Phase 1)

- **`s1 + s2` / template concat** (`string.concat`): join the operand
  encodings per the lattice. Concatenating two well-formed UTF-8 strings
  cannot introduce a lone surrogate; concatenating two ASCII strings stays
  ASCII. (A WTF-16 operand forces `wtf16`, which conservatively covers the
  surrogate-split-across-the-seam case.)

Phase 2 propagation (deferred): `.toUpperCase`/`.toLowerCase`/`.trim`/
`.normalize` (preserve), `.slice` on statically known code-point boundaries
(preserve else drop), `.repeat`/`.padStart`/`.padEnd` (preserve),
`.split`/`.replace` (conditional). Any operation without an explicit rule
drops to `wtf16`.

### Component Model boundary integration (deferred to Phase 2/3)

The boundary lowering will read the annotation and select a path: zero-copy
for `ascii`/`utf8-guaranteed` (when the runtime string representation
permits), and the existing scan-and-encode path for `wtf16`. Two storage
strategies are on the table — **dual storage** (`(array i8)` for proven-UTF-8
allocation sites, `(array i16)` for WTF-16) and a **lazy re-encoding cache**.
Dual storage is preferred for new allocations because it eliminates the copy;
it requires the annotation to be available before storage layout is committed.
Neither is implemented in Phase 1; the analysis lands first so the boundary
work has data to consume.

## Why this scope for Phase 1

The issue (#1588) targets a useful initial version: lattice + analysis pass +
the canonical origin/propagation set, banking the infrastructure that the
boundary work depends on. The only string-producing IR instrs that currently
carry an allocation-site id are `string.const` and `string.concat`, so those
are the two rules the analysis can attach annotations to today. Call-result
origins (`JSON.parse`, `TextDecoder`) and method propagation require the IR to
mint string alloc ids on those results first — tracked as Phase 2 follow-up.

## Phase 2 status

**PR-A (landed, still inert).** The builder now mints a `"string"`
allocation-site id on `call` and `extern.call` instrs whose result type is
`string` (`emitCall` / `emitExternCall`). This is inert at lowering — the
emitted Wasm is byte-identical — and gives the analysis an attachment point
for call-result rules:

- **Call-result origins**: `JSON.parse` / `JSON.stringify` (host import names
  `JSON_parse` / `JSON_stringify`) → `utf8-guaranteed`. `TextDecoder.decode`
  (an `extern.call`) → `utf8-guaranteed`.
- **Method propagation**: string methods lower to a `call` named
  `string_<m>` (host) or `__str_<m>` (native) with the receiver as the first
  argument. Methods that cannot introduce a surrogate from non-surrogate
  input — `toUpperCase`, `toLowerCase`, `trim`, `trimStart`, `trimEnd`,
  `normalize`, `padStart`, `padEnd`, `repeat` — propagate the receiver's
  encoding. `slice` / `substring` / `charAt` are **not** preserving:
  code-unit indexing can split a surrogate pair, so they conservatively drop
  to `wtf16` (refining `slice` with statically-known code-point boundaries is
  a later refinement). Any other string-returning call is `wtf16`.

**PR-B part 1 (landed, gated scaffolding — inert when off).** The dual-storage
foundation, all behind `--utf8-storage` (default OFF, implies `nativeStrings`
on the WasmGC backend):

- New WasmGC types registered **only when the flag is on** (so the type table
  is byte-identical when off): `__str_data_u8 = (array (mut i8))` and
  `Utf8String = { len:i32, byteLen:i32, off:i32, data:ref __str_data_u8 }`, a
  third `AnyString` subtype alongside `NativeString`/`ConsString`. `len` stays
  the JS-visible code-unit (UTF-16) length; `byteLen` is the canonical-ABI
  size.
- `--utf8-storage` flag plumbed: `CompileOptions` / `CodegenOptions` /
  `CodegenContext.utf8Storage`, the CLI (`--utf8-storage`), `compiler.ts`, and
  the `nativeStrings` implication in `create-context.ts`.
- `nativeStringLiteralInstrs(ctx, value, encoding?)` emits an i8-backed
  `Utf8String` (with compile-time-computed UTF-8 bytes) for
  `ascii`/`utf8-guaranteed`, the existing i16 `NativeString` otherwise. The
  UTF-8 encoder asserts no lone surrogate (defensive classifier-bug guard —
  §4 soundness anchor).
- The live `AllocSiteRegistry` is exposed on `ctx.allocRegistry` from the IR
  pipeline so the lowering sites can read the `encoding` annotation.

This part is **not yet reached at runtime**: the IR lowering resolver still
calls `nativeStringLiteralInstrs(ctx, value)` without an encoding, so even with
`--utf8-storage` on, literals currently take the i16 path. Wiring the resolver
to pass the annotation + the access-primitive `Utf8String` dispatch arm is
**PR-B part 2** (required before the path is correct end-to-end, since an
i8 string must be readable by `charCodeAt`/`length`).

**PR-B part 2 (next).** Thread `instr.alloc` through the `emitStringConst`
resolver hook (`lower.ts`), read the annotation at the literal/concat/flatten
sites, and add the third subtype-dispatch arm to the access primitives in
`ensureNativeStringHelpers` so `Utf8String` interoperates with
`NativeString`/`ConsString` in the same module. Round-trip + fuzz correctness
tests. **Alias-fusion soundness guard** (issue §4): before any CSE may fuse
string sites, enforce that a `wtf16` site never aliases into a `utf8`
canonical (no string-fusing pass exists today — forward guard).

**PR-C (deferred).** Component Model boundary lowering (Edge A `c-abi.ts` scan
elision; Edge B `declarations.ts` import selection + standalone Wasm-native
`string_to_utf8`) + benchmark. See "## Phase 2 ABI Plan" in the #1588 issue
file for the full design.

## Consequences

- **Soundness is the bar.** A wrongly-conservative annotation only costs a
  slower path; a wrongly-optimistic one is a correctness bug (malformed UTF-8
  at the boundary). Every rule errs conservative: default `wtf16`, only
  audited rules promote. The literal classifier explicitly demotes lone
  surrogates to `wtf16`.
- **No semantic change.** WTF-16 indexing, `.length`, comparison, etc. are
  untouched. The annotation is internal to the compiler/runtime.
- **Advisory until a consumer lands.** Phase 1 produces annotations with no
  reader; the boundary lowering (Phase 2/3) is the first consumer. The
  annotations are exercised by unit tests in the interim.
- **Reference-Typed Strings.** If that proposal stabilizes, type information
  may replace inference, but the propagation rules and CM dispatch logic
  remain useful.

## References

- ADR-0013 — explicit allocation sites (the attachment mechanism)
- ECMA-262 §6.1.4 (String type / WTF-16), §24.5.2 (JSON.stringify)
- WHATWG Encoding (TextDecoder UTF-8 guarantees), RFC 8259 (JSON UTF-8)
- Component Model CanonicalABI (`string`)
