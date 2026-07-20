---
id: 1044
title: "Node builtin modules as host imports (NODE_HOST_IMPORT_MODULES, node: prefix normalization)"
horizon: m
status: done
completed: 2026-07-17
assignee: ttraenkler/opus-b
created: 2026-04-11
updated: 2026-07-19
priority: high
feasibility: medium
reasoning_effort: high
goal: async-model
sprint: 72
parent: 1032
depends_on: [1041]
required_by: [1032, 1058]
---

# #1044 — Node builtin modules as host imports

## Problem

The compiler has no special handling for Node builtin module specifiers. Every `import http from 'node:http'` flows through `src/import-resolver.ts:23` `preprocessImports` and becomes `declare const http: any`, which erases symbol-level typing and makes the host-boundary design ad-hoc.

For #1032 (axios stress test) to get past Tier 2, the compiler must recognize Node-builtin module specifiers and route them through host-provided externref imports — not compile them, not polyfill them, just import their symbols.

## Approach

1. Add a `NODE_BUILTIN_MODULES` set in `src/import-resolver.ts` (alongside `preprocessImports`):

   ```ts
   const NODE_BUILTIN_MODULES = new Set([
     "http",
     "https",
     "http2",
     "url",
     "querystring",
     "stream",
     "stream/web",
     "events",
     "buffer",
     "zlib",
     "util",
     "path",
     "process",
     "net",
     "tls",
     "fs",
     "crypto",
   ]);
   function isNodeBuiltin(spec: string): boolean {
     return NODE_BUILTIN_MODULES.has(spec.replace(/^node:/, ""));
   }
   ```

2. When `isNodeBuiltin(spec)` is true, emit a `declare namespace <importName> { ... }` stub keyed by usage analysis (same machinery as existing namespace imports) **and** mark the module for late externref-import emission in codegen.

3. In `src/runtime.ts`, add a Node-builtin branch to the import resolver that does `require(moduleName)[importName]` in JS-host mode.

4. In `--target wasi` mode, error cleanly with "Node builtin X is not available in WASI target — use #1035's compile-time syscall path for node:fs".

5. `node:` prefix: normalize so `'http'` and `'node:http'` resolve to the same entry.

## Surface to support (axios Tier 4 needs)

- `http.request`, `http.get`, `http.Agent`
- `https` (all of `http` + TLS)
- `url.URL`, `url.parse`, `url.format`
- `stream.Readable`, `stream.Writable`, `stream.Transform`, `stream.pipeline`
- `events.EventEmitter` (on, once, emit, removeListener)
- `buffer.Buffer` (static `from`, `concat`, `byteLength`; prototype `toString`, `slice`)
- `zlib.createGzip`, `zlib.createGunzip`
- `util.promisify`, `util.inherits`, `util.types`
- `process.env`, `process.platform`, `process.version`

## Acceptance criteria

- [ ] `NODE_BUILTIN_MODULES` set defined in `src/import-resolver.ts`
- [ ] `import http from 'node:http'` and `import http from 'http'` both resolve to the same host import
- [ ] axios Tier 4 (`lib/adapters/http.js`) compiles without `declare const X: any` stubs for Node builtins
- [ ] `--target wasi` produces a clear error when a non-`node:fs` builtin is used
- [ ] `Buffer` global registered as an extern class following the `Map`/`Set` pattern at `src/codegen/index.ts:2661,:4100`

## Non-goals

- Implementing any Node builtin in WasmGC (we import, not compile)
- Full Node API surface — start with what axios Tier 4 needs
- Async/await state-machine lowering — tracked separately as #1042

## Related

- Parent: **#1032** (axios stress test — this is its core compiler prerequisite)
- Depends on: **#1041** (pre-bundled single-file input — required for any multi-file npm package)
- Coordinate with: **#1035** (WASI `node:fs` compile-time syscall path — two different mechanisms with overlapping surface; design together)
- Architecture: `plan/design/architecture/npm-stress-compiler-gaps.md` cross-cutting gap #3

## Resolution (2026-07-17)

The recognition machinery landed **incrementally** across the sprint rather than
in a single PR, and criterion 5's last gap was closed here:

- **`NODE_BUILTIN_MODULES` set + `isNodeBuiltin` + `normalizeNodeBuiltin`** —
  `src/import-resolver.ts` (set now spans http/https/url/stream/events/buffer/
  zlib/util/fs/crypto/os/module/fs-promises/… — well beyond the original spec).
- **`node:` prefix normalization** — `import http from "node:http"` and
  `import http from "http"` resolve to the same host import
  (`normalizeNodeBuiltin` strips the `node:` prefix). ✔ criterion 2.
- **Host-import routing (no `declare const X: any` erasure)** — node-builtin
  imports push to `nodeBuiltins` → late externref host import; typed function
  stubs (`__nodefn__<mod>__<fn>`, #1492/#1795/#2699) and extern-class stubs
  (#1794) for known members. ✔ criterion 3 (the axios Tier-4 surface —
  http/https/url/stream/events/zlib/util/buffer — compiles routing through host
  imports; full `lib/adapters/http.js` also needs async lowering #1042, a
  declared non-goal here).
- **WASI capability gate** — a non-`node:fs` builtin under `--target wasi`
  errors cleanly: _"Node builtin module 'http' is not available in WASI
  target…"_ rather than crashing. ✔ criterion 4.
- **Global `Buffer`** — #1793 registered `Buffer` in `BUILTIN_CLASS_NAMES` so
  `Buffer.from`/`alloc`/`concat` lower syntactically. This PR closed the last
  gap: `buildNodeEnvDts` (`src/checker/index.ts`) now injects an ambient
  `declare var Buffer: BufferConstructor` (parallel to the `process` global),
  so the global form type-checks under `--emulate node` instead of emitting a
  spurious _"Cannot find name 'Buffer'"_. Gated behind `--emulate node` (like
  `process`/`Deno`), so the common web/test262 path stays byte-neutral; a local
  `Buffer` import binding or a user-declared `Buffer` suppresses the inject.
  ✔ criterion 5.

Verification: `tests/issue-1044.test.ts` (9 tests: global-Buffer ambient typing,
import-scoped dts, node:-prefix normalization, WASI gate) + the existing
`tests/issue-1793.test.ts` (7) all green.
