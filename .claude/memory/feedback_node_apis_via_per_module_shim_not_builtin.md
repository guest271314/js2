---
name: feedback_node_apis_via_per_module_shim_not_builtin
description: Node API surfaces must be provided by per-module js2wasm:node-<mod> shims linked at the import boundary, never baked into codegen as compiler builtins
metadata:
  type: feedback
---

Node API surfaces (`node:fs`, `node:process`, …) must be provided by an
**imported host interface named after the node module itself** — the wasm import
module name IS `node:fs` / `node:process`, member names are the real Node members
(`readSync`, `writeSync`). NOT special-cased as compiler builtins that inline
syscall sequences (e.g. `fd_read`/`fd_write`) into codegen, and NOT named
`js2wasm:node-<mod>` (that leaks the shim *implementation* into the module's
declared dependency).

**The module declares WHAT host API it requires, not HOW it's satisfied.**
`import {readSync} from "node:fs"` → the wasm declares `import "node:fs"
"readSync"`. Whether that import is provided by our `.wat` shim, a native WASI
host, or (under a JS host) the *real* `node:fs` module passed straight in as the
import object, is a **link-time** concern invisible to the module. The shim
(`examples/native-messaging/node-fs.wat`) is just one provider, linked via
`--link-node-shims`.

**Why:** keeps Node semantics out of the compiler core; the host interface is
swappable (deno, WinterTC, WASI, real Node) without the module knowing; declaring
`node:fs` is the honest statement of the dependency, whereas `js2wasm:node-fs`
falsely bakes "this is a js2wasm shim" into the contract. Matches the #389
reporter's WASI-host point: don't bake opinionated Node support into the target —
but DO let a module honestly declare the host API it needs. The narrow ABI today
(`readSync(ptr,len)->i32` over shared linear memory) can be extended to more of
the `node:fs` surface later.

**How to apply:** when adding a `node:<mod>` surface, recognize the imported
member call and emit a call to the imported `node:<mod>::<member>` (runtime
import, real Node member name), import-scoped to only the used members, and ship
a `<mod>.wat` shim (mirror `examples/native-messaging/node-process.wat`)
that implements it over WASI as ONE provider. The codegen side only resolves
which import maps to which member — no inlined syscall lowering, no Node
semantics in codegen.

**Migration note:** the landed `js2wasm:node-process` shim (#2524/#1953) predates
this and should be renamed `node:process` (member names → real Node members) for
consistency — rename early. See [[feedback_node_emulation_split_by_import]] and
the #389 native-messaging host switch (#2631 node:fs, #2632 event loop).

Note the fd-based `node:fs` `readSync(fd,…)`/`writeSync(fd,…)` are **filesystem-
free** — they operate on integer fds (0/1/2), not paths, so they need NO
`path_open`/preopens. Only the path-based `fs` family (`readFileSync(path)`)
needs a filesystem (`--allow-fs`). Living in `node:fs` is a Node quirk, not a
filesystem dependency. See [[feedback_node_emulation_split_by_import]] and the
#389 native-messaging host switch (#2631).
