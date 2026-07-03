---
id: 2829
title: Retest all four native-messaging hosts in Chrome on 0.59.3
status: done
sprint: 69
priority: high
area: examples
task_type: bug
related: [389, 2814, 2807, 2832, 2839, 2840]
---

## Resolution (verified — all four work)

Retested via `examples/native-messaging/scale-test.mjs` under real wasmtime 46
and end-to-end on the final 0.59.5 tree. **All four hosts work**; the reporter's
"only node_fs works" was a pre-0.59.2 build:

- `nm_js2wasm_deno`, `nm_js2wasm_wasi_p1`, `nm_js2wasm_node_fs` — round-trip
  byte-exact at 1/64/128/256 MiB, bounded memory. The `"Error communicating with
  the native messaging host"` was the pre-#2814 verbatim echo of a single
  >1 MiB frame (Chrome drops any host→extension message >1 MB); #2814's re-chunk
  fixed it.
- `nm_js2wasm_node_process` — the ~98%-memory blowup was the unbounded read side
  (RSS ~8× frame: ~530 MB @ 64 MiB). Fixed by #2832 (read-side streaming) →
  flat ~35 MB. The `.js` standalone compile (`__vec_from_extern` externref) was
  fixed by #2839; the `.ts`-direct compile (`#1886`) by #2840.

All shipped in 0.59.4/0.59.5. Closing as done.


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
