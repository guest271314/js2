---
id: 2829
title: Retest all four native-messaging hosts in Chrome on 0.59.3
status: ready
sprint: current
priority: high
area: examples
task_type: bug
related: [389, 2814, 2807]
---

# Verify all four native-messaging hosts work in the browser on 0.59.3

## Problem

The loopdive/js2#389 reporter says only `nm_js2wasm_node_fs` works as a Chrome
native-messaging host. `nm_js2wasm_deno`, `nm_js2wasm_wasi_p1`, and
`nm_js2wasm_node_process` all fail in the browser:

- `nm_js2wasm_deno` and `nm_js2wasm_wasi_p1` → `"Error when communicating with
  the native messaging host"`.
- `nm_js2wasm_node_process` → climbed to ~98% memory echoing a 64 MiB frame and
  never replied.

The reporter tested a **pre-0.59.2** build. The symptoms he saw — the `.js.wasm`
output names, the 64 MiB echo, and the `Cannot find name 'Deno'` warning — all
predate fixes that have since landed:

- re-chunk to ≤1 MiB JSON frames (#2814),
- the Deno-warning suppression (#2815),
- the output-name fix (#2816),

all of which are now in 0.59.3.

## Goal

Retest all four hosts as **actual Chrome native-messaging hosts** on 0.59.3. For
each host, either:

1. document a working build + manifest recipe, or
2. root-cause the remaining failure and file the residual bug.

Note the two failure classes are likely distinct: the
`"Error when communicating"` on `deno`/`wasi_p1` may be a launcher/runtime issue,
whereas the `node_process` memory blowup should already be fixed by the #2814
re-chunk. Confirm the re-chunk resolves `node_process` and pin down whatever
remains for `deno`/`wasi_p1`.
