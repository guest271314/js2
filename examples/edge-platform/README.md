# Reference platform scenario: a Node-oriented program on Wasmtime, no Node.js engine

This example demonstrates one specific, load-bearing distinction in the `js²`
deployment story:

> **Preserving a familiar platform surface is not the same thing as keeping
> Node.js as the deployment runtime.**

We take a small Node-oriented TypeScript program — it imports `node:fs` and uses
`console` — and run it on **Wasmtime** as a standalone WebAssembly module. The
`node:fs` calls are lowered by js2wasm to **WASI filesystem syscalls**, and
`console.log` is lowered to WASI `fd_write`. No JavaScript engine ships in the
deployment unit; the host (the WASI runtime) re-provides the platform surface.

This is the same dual-mode principle as the WASI hello-world
([`../wasi/`](../wasi/)), framed as a _deployment scenario_: the question for a
target environment becomes **"which host APIs exist?"** rather than **"is
Node.js present?"**.

## The program

[`generate-artifacts.ts`](./generate-artifacts.ts) writes a service manifest and
a deploy marker through the `node:fs` API:

```ts
import { writeFileSync } from "node:fs";

console.log("Generating deployment artifacts (node:fs on Wasmtime)...");

writeFileSync("manifest.json", '{ "name": "checkout-service", ... }\n');
console.log("  wrote manifest.json");

writeFileSync("DEPLOY.md", "# checkout-service\n...\n");
console.log("  wrote DEPLOY.md");
```

There is nothing Wasm-specific in the source. It is ordinary
Node-oriented TypeScript using two of the most common platform APIs.

## Run it

```bash
examples/edge-platform/run.sh
```

The script compiles `generate-artifacts.ts` with `--target wasi` and runs the
resulting `.wasm` on Wasmtime. Expected output:

```
==> Compiling .../generate-artifacts.ts to WASI WebAssembly
==> Compiled 6360 bytes: .../out/generate-artifacts.wasm
==> Running on Wasmtime (no Node.js engine present)
Generating deployment artifacts (node:fs on Wasmtime)...
  wrote manifest.json
  wrote DEPLOY.md
Done. Two files written through the node:fs platform API.
==> Files produced by node:fs on the WASI host:
--- manifest.json ---
{
  "name": "checkout-service",
  "version": "2.4.1",
  "runtime": "wasm32-wasi"
}
--- DEPLOY.md ---
# checkout-service

Built to WebAssembly via js2wasm.
Runs on any WASI host — Node.js is not required at deploy time.
```

### Manual steps

```bash
mkdir -p examples/edge-platform/out
npx tsx src/cli.ts examples/edge-platform/generate-artifacts.ts \
  --target wasi -o examples/edge-platform/out

cd examples/edge-platform/out
wasmtime run \
  -W gc=y -W function-references=y -W tail-call=y -W exceptions=y \
  --dir=. generate-artifacts.wasm
```

The `-W` flags enable the WasmGC, typed-function-references, tail-call, and
exception-handling proposals that the compiled module uses. `--dir=.` maps the
working directory into the WASI sandbox so `writeFileSync` may create files —
this _is_ the capability model: the file write only succeeds because the host
explicitly granted directory access, not because Node.js happened to be running.

## What the host provides vs. what Node.js would have provided

| Platform call in the source | Lowered to                            | Provided by                  | Node.js engine needed? |
| --------------------------- | ------------------------------------- | ---------------------------- | ---------------------- |
| `console.log(s)`            | `fd_write` (fd=1)                     | WASI runtime (Wasmtime)      | No                     |
| `writeFileSync(path, data)` | `path_open` → `fd_write` → `fd_close` | WASI runtime + `--dir` grant | No                     |

The compiled module imports **only** from `wasi_snapshot_preview1`. There are no
`env.*` imports and no embedded JS engine. The `node:fs` _surface_ survives; the
Node.js _runtime_ does not appear in the deployment unit.

## What assumptions about a traditional Node runtime are no longer required

- **No bundled JS engine.** The deployment artifact is a ~6 KB `.wasm`, not a
  Node binary plus a script. Startup is module instantiation, not engine boot.
- **No `node_modules` at deploy time.** `node:fs` is satisfied by the compiler's
  WASI lowering, not by a Node standard library shipped alongside the code.
- **No ambient filesystem authority.** Node grants a process the whole
  filesystem by default; here the host grants exactly the directories passed via
  `--dir`. Capability is explicit and host-controlled.
- **Runtime portability instead of Node-version portability.** The same `.wasm`
  runs on any WASI preview1 host (Wasmtime, Wasmer, wazero, Node's built-in
  `node:wasi`); see [`../wasi/README.md`](../wasi/README.md) for the runtime
  matrix and for `wasmer create-exe` / `wasmtime compile` native-binary wrapping.

## Scope and honest limitations

This is a **reference platform path**, not a full Node compatibility layer.

- The demonstrated WASI `node:fs` surface is `writeFileSync` with **string
  paths and string data**. `readFileSync` and the rest of `node:fs` under
  `--target wasi` are tracked follow-ups (#1036–#1042); the JS-host (`--allow-fs`)
  mode covers `readFileSync`/`writeFileSync` today for the Node/browser target.
- Runtime-composed (concatenated/templated) file _contents_ under `--target
wasi` still depend on the GC-string → linear-memory encoder work; this demo
  uses string literals, which is the reliably-supported path. The encoder is
  the same dependency called out in [`../wasi/README.md`](../wasi/README.md).
- A deeper "Node API module / shim layer" via edge.js — letting user code
  `import` an explicit Node-compatible shim that the compiler lowers to WASI —
  is the spike tracked in **#1772**. This example is the end-to-end deployment
  proof that motivates that spike, not the shim itself.

## Why this matters

This turns an abstract architectural argument into something operational:
JavaScript/TypeScript can target Wasm-native infrastructure without bundling a
JS engine into each deployment unit, and existing Node-oriented code has a
plausible migration path toward Wasm-native serverless and edge environments.

## Related

- [`../wasi/`](../wasi/) — WASI hello-world: `console.log` + `node:fs` →
  WASI syscalls, plus native-binary wrapping (`#1035`)
- `#1099` — standalone execution demo (FizzBuzz on Wasmtime, zero JS host)
- `#640` — WASI HTTP handler (serverless edge)
- `#1772` — spike edge.js as a Node API / WASI shim layer
