# #2658 B0 spike — native WASI Preview 3 (0.3) async, de-risked

This directory is the **runnable output of the #2658 Slice B0 spike** — the
de-risking probe for "target WASI Preview 3". It is **not** the js2wasm P3
producer (that is the deferred B2–B4 epic, gated on #2525). It proves the P3
async _runtime target_ works on this box and pins the exact binary shape a
js2wasm P3 producer must emit. Full write-up: `plan/issues/2658-wasi-preview3-target.md`
→ "B0 Spike Findings".

## Files

| File              | What it is                                                                                                                              | State                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `run-async.wat`   | Minimal P3 component exporting `wasi:cli/run@0.3.0-rc-2026-03-15` as an **async**-lifted `run` (async lift + callback + `task.return`). | ✅ **Runs** under wasmtime 44.                                                                                             |
| `stream-echo.wat` | The P3 `stream<u8>` stdin→stdout echo, authored against the authoritative WIT (host-driven stream hand-off).                            | ⚠️ Parses with jco; **blocked at wasmtime decode** by the `future<T>` encoding skew. Serves as the binary-shape reference. |
| `wit/cli.wit`     | Authoritative `wasi:cli@0.3.0-rc-2026-03-15` stdio interfaces (trimmed from wasmtime v44).                                              | reference                                                                                                                  |
| `run-p3-b0.sh`    | Build + run both artifacts; shows #1 running and #2 hitting the documented gap.                                                         | —                                                                                                                          |

```bash
bash examples/native-messaging/p3-b0-spike/run-p3-b0.sh
```

## What the spike established

- **wasmtime 44 hosts WASI `0.3.0-rc-2026-03-15`** (NOT final `0.3.0`) via
  `-S p3=y`, with `-W component-model-async{,-builtins,-stackful}=y` enabling the
  async canonical ABI and the `task.*`/`waitable-set.*`/`stream.*`/`future.*`
  built-ins.
- **The async-command half of the ABI runs here** — async lift, callback, and
  `task.return` are functional (`run-async.wat`). So a _synchronous_ P3 `run`
  producer (B2) is unblocked.
- **The `stream`/`future` half is blocked by a toolchain encoding skew, not a
  feature flag.** Any component using a `future<T>` type fails to _decode_ in
  wasmtime 44 ("instance not valid to be used as import"), in import or export
  position, under every async flag combination. Bisected: bare `stream<u8>` and
  `tuple<stream<u8>, u32>` decode fine; adding a `future<…>` member breaks it.
  The bundled wasm-tools (jco 1.16.1) _encodes_ `future` in a layout wasmtime
  44's decoder rejects — a component-model-async type-encoding version skew.
- **Named prerequisite for B3:** build the P3 producer against a wasm-tools whose
  `future`/`stream` encoding matches wasmtime 44, and validate with `wasmtime`
  directly (not only `jco parse`, which masked the skew).

## The P3 echo shape (why P3 is the clean substrate for #2646)

P3 stdio is a host-driven stream hand-off:

```
run():
  let (s, _read_fut) = stdin.read-via-stream();   // s: stream<u8>
  let write_fut      = stdout.write-via-stream(s); // host pumps s -> stdout
  await write_fut;                                  // suspend/resume via host scheduler
```

The host drives the stdin→stdout copy and the async-lifted `run` suspends at the
await — exactly the incremental loop-borrow #2646 needs, with no asyncify and no
pre-drain. Contrast `../nm_js2wasm_wasi_p1.ts` (P1), which hand-marshals iovecs through
linear memory in an explicit `fd_read`/`fd_write` loop.
