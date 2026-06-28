---
id: 2776
title: "WASI Preview 3 / Component Model support — compile nm_wasi_p3 to a working P3 component with async stream<u8>"
status: backlog
created: 2026-06-27
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: examples, codegen
language_feature: wasi-p3, component-model, async-stream
goal: standalone-wasi
related: [389, 2657, 2775]
sprint: Backlog
---

# #2776 — WASI Preview 3 / Component Model support

`examples/native-messaging/nm_wasi_p3.ts` is currently a SOURCE-REFERENCE arm: it
describes the WASI Preview 3 (0.3) async `stream<u8>` echo host the comparison
wants, but js2wasm cannot yet emit a P3 component, so it does not compile to a
runnable binary. The `p3-b0-spike/` directory PROVES the runtime target works via
hand-authored WAT (`run-async.wat`, `stream-echo.wat`); this issue is the
compiler work to make `nm_wasi_p3.ts` compile to a real, working P3 component.

## Scope

Implement WASI Preview 3 / Component Model producer support so a host with an
async-lifted entry compiles to a component that:

- exports the async-lifted `wasi:cli/run@0.3.0-rc` `run` command,
- imports `wasi:cli/stdin#read-via-stream` / `wasi:cli/stdout#write-via-stream`,
- lowers `stream<u8>` / `future<T>` handles through the canonical ABI,
- emits the `component-type` custom section, and
- suspends/resumes the async task on the component-model scheduler (no asyncify,
  no pre-drain) so stdin streams incrementally.

This is a sizeable feature: Component Model emission + P3 async-stream codegen.
It mirrors the #2658 B2-B4 producer epic (gated on #2525) and the spike under
`examples/native-messaging/p3-b0-spike/`.

## Framing the contrast (why this matters)

The loopdive/js2#389 reporter's `componentize-qjs` path **embeds QuickJS** —
it ships a whole JS interpreter INSIDE the component and runs the host source on
it. js2wasm's approach is to **compile the TypeScript directly** to Wasm: there
is NO embedded interpreter, so the emitted component is just the host logic plus
the WASI/component-model glue. The P3 arm makes that contrast concrete — a
compile-direct P3 component vs. an interpreter-embedding one — for the same
Native Messaging echo host.

## Acceptance

- [ ] `nm_wasi_p3.ts` compiles to a valid WASI Preview 3 component (async-lifted
      `run`, `stream<u8>`/`future<T>` canonical-ABI lowering, `component-type`
      section).
- [ ] The component echoes a framed Native Messaging message byte-for-byte under
      a P3-capable host (e.g. wasmtime hosting `wasi:cli@0.3.0-rc`).
- [ ] The comparison/matrix harness picks up the P3 arm as a runnable variant
      (currently skipped).
- [ ] No embedded interpreter in the emitted component (compile-direct, contrast
      with componentize-qjs).
