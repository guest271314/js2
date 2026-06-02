---
id: 1767
title: "native-messaging 64 MiB run grows wasmtime memory toward OOM"
status: done
created: 2026-06-01
updated: 2026-06-02
completed: 2026-06-02
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: typed-arrays
goal: platform
sprint: 58
parent: 1753
depends_on: [1753]
es_edition: n/a
related: [389, 1655, 1723, 1724, 1753]
origin: "GitHub #389 guest271314 comment 2026-06-01T00:17:59Z"
claimed_by: codex-developer
claimed_at: 2026-06-02T11:04:55.165Z
---
# #1767 — native-messaging 64 MiB run grows wasmtime memory toward OOM

## Problem

guest271314 reports that the current TypeScript native-messaging host can
process the 64 MiB case, but wasmtime memory grows aggressively while handling
the workload. His Debian 13 live-system Task Manager capture shows memory
climbing near machine capacity while `nm_js2wasm.wasm` processes a 64 MiB
`Array` input and sends back <=1 MiB chunks.

That makes #1753's large-payload path unsafe even if the protocol-level chunking
works. A 64 MiB native-messaging test must not risk exhausting system memory.

Source: <https://github.com/loopdive/js2/issues/389#issuecomment-4588674539>

## Reported workload

The reporter's browser-side stress case:

```js
var data = Array(209715 * 64);
var len = data.length;
var n = 0;
var port = chrome.runtime.connectNative("nm_js2wasm");
port.onMessage.addListener((message) => {
  n += message.length;
  if (n === len) {
    console.log({ n, len });
    port.disconnect();
  }
});
port.postMessage(data);
data.length = 0;
```

Expected result:

```js
{ n: 13421760, len: 13421760 }
```

He also reported a rough end-to-end runtime of `1:53` for the 64 MiB case and
called out that the memory behavior undermines performance comparisons.

## Historical blocking context

When this issue was opened, #1753's full 64 MiB read/write story was still
open. The #1767 branch first took the needed write-side slice: the
native-messaging example emitted large responses as <=1 MiB frames through a
reusable chunk buffer instead of one oversized stdout write.

## Blocked findings — 2026-06-01

Repo inspection confirms the dependency is still absent:

- #1753 is still `status: ready`, not implemented. The shipped
  `examples/native-messaging/nm_js2wasm.ts` host reads one declared frame body
  into a single `Uint8Array` and `sendMessage()` writes one response frame.
  That can measure wasmtime memory for the current byte echo, but it cannot yet
  prove Chrome-safe host-to-browser chunking for a 64 MiB response.
- `examples/native-messaging/background.js` only contains a commented
  one-chunk `port.postMessage(new Array(209715))` probe. There is no committed
  browser-side 64x workload harness.
- `examples/native-messaging/smoke-test.sh` is a real-wasmtime byte-exact smoke
  test for a small JSON frame. `tests/issue-1530.test.ts` covers compile/import
  validity plus byte-exact echo up to 1 MiB. Neither test measures RSS or runs a
  64 MiB stress case, which is correct for fast CI.

Small safe advancement landed in the example docs/harness:

- Added `examples/native-messaging/stress-memory.mjs` as an opt-in local
  wasmtime stress runner. Its default payload is
  `JSON.stringify(Array(209715))`, exactly a 1 MiB body, so it is safe for quick
  local checks.
- The reporter-shaped run is manual only:

  ```bash
  node examples/native-messaging/stress-memory.mjs --reported-64mib --allow-large-response-frame
  ```

  `--reported-64mib` streams `Array(209715 * 64)` as a Native Messaging JSON
  body without retaining that body in the Node harness. The flag
  `--allow-large-response-frame` is required before #1753 because the current
  echo host writes one oversized response frame. After #1753 lands, the same
  command should be run without that flag so `max_response_frame_body_bytes`
  enforces the 1 MiB budget.

### Measurement plan

Record one row per run, including:

- tool/runtime versions: git SHA, Node version, `wasmtime --version`, OS;
- workload shape: `array_elements`, `request_body_bytes`, chunk budget;
- protocol output: `response_frames`, `response_body_bytes`,
  `max_response_frame_body_bytes`;
- process memory: first sampled RSS, peak sampled RSS, and VmHWM where procfs is
  available;
- elapsed time and stderr diagnostics;
- wasm linear-memory pages once an instrumented runner/export exists. For the
  CLI wasmtime path, RSS/peak are measurable now; page counts need either a
  JS-WASI runner that can inspect `instance.exports.memory.buffer.byteLength` or
  a temporary debug export wired into the stress build.

### Acceptance budget shape

The final #1767 pass/fail should be platform-normalized around deltas rather
than absolute Task Manager numbers:

- protocol: every host-to-browser response frame is `<= 1048576` bytes, and the
  reported `Array(209715 * 64)` case completes with the expected total element
  count (`13421760`) after #1753's reassembly/chunking path exists;
- memory: peak RSS delta should be bounded by the input body plus a small number
  of chunk/scratch buffers, not by retained copies of every response chunk. Use
  a first red budget of `baseline_rss + 256 MiB` for the 64x run, then replace
  it with measured per-platform numbers once #1753 produces a real chunked
  run;
- wasm pages: peak linear memory should plateau after the input/body and current
  chunk buffers are allocated. A growing page count across response chunks is a
  regression signal even if RSS happens to lag.

## Implementation slice — 2026-06-01

The branch `codex/1767-native-messaging-memory-growth` unblocks the response
side of #1753 enough to move this issue from `blocked` to `in-progress`:

- `examples/native-messaging/nm_js2wasm.ts` now keeps <=1 MiB messages
  byte-exact, but routes larger responses through a bounded writer that emits
  successive <=1 MiB Native Messaging frames.
- The reported Chrome workload (`Array(209715 * 64)`) is handled as valid JSON
  array chunks. Each chunk carries at most 209,715 `null` elements, which
  serializes to exactly 1 MiB, so Chrome can deliver each frame to
  `port.onMessage` and the extension can sum `message.length`.
- Non-array large byte bodies still use raw <=1 MiB byte chunks for the
  harness/future Uint8Array Native Messaging path. That preserves the bounded
  memory property without claiming arbitrary JSON fragments are Chrome-valid.
- `examples/native-messaging/stress-memory.mjs` now validates response frame
  budgets and array-element totals without retaining response bodies. The
  `--reported-64mib` run has default guardrails: sampled RSS may grow at most
  256 MiB above the first sample and the child is killed after 180 seconds.
- `tests/issue-1767.test.ts` covers the 1 MiB + 1 raw-byte boundary and the
  209,716-element null-array boundary, asserting two <=1 MiB response frames
  and valid JSON array chunks for the Chrome-shaped case.

Manual full run, not for normal CI:

```bash
node examples/native-messaging/stress-memory.mjs --reported-64mib
```

## Final implementation and measurement — 2026-06-02

Status: done on `symphony/1767`; ready PR opened as
<https://github.com/loopdive/js2/pull/1039>.

Root cause:

- The first guarded 64x wasmtime run on this branch reproduced the unsafe memory
  shape even after response chunking. With `wasmtime 45.0.0`, RSS reached
  `299.2 MiB` after 19 request frames (`+295.6 MiB` over the first sample), so
  the stress harness killed the child before any response frames were emitted.
- The cause was request-side continuation aggregation. The host copied each
  <=1 MiB request frame into a growing `ArrayBuffer` logical-message store
  before writing the response. Under wasmtime/WasmGC, that storage grows RSS
  aggressively and defeats the bounded response writer.

What changed:

- `sendMessageWithContinuations()` no longer builds a full 64 MiB request
  buffer. It streams continuations under the existing 64 MiB ceiling.
- Raw byte continuations are echoed one <=1 MiB response frame at a time as they
  are read.
- The reported Chrome `Array(209715 * 64)` shape is parsed with a streaming
  null-array scanner that carries state across request frames, counts elements,
  and then emits valid <=1 MiB JSON array response chunks. This preserves
  `port.onMessage` delivery and lets the extension sum `message.length`.
- The stress harness now listens for child stdin `error` events, so guard kills
  or early child exits report `EPIPE` in the structured result instead of
  crashing Node before the RSS/protocol summary is printed.

Guarded reported-workload measurement:

```text
command=node examples/native-messaging/stress-memory.mjs --reported-64mib
node_version=v25.8.2
wasmtime_version="wasmtime 45.0.0 (377cd917a 2026-05-21)"
mode=chrome-array
array_elements=13421760
request_body_bytes=67108801
request_frame_budget_bytes=1048576
response_frames=64
response_body_bytes=67108864
response_array_elements=13421760
max_response_frame_body_bytes=1048576
chunk_budget_bytes=1048576
rss_source=procfs
rss_first_mb=3.3
rss_peak_sampled_mb=36.1
rss_peak_hwm_mb=36.1
rss_peak_delta_sampled_mb=32.8
rss_limit_delta_mb=256
rss_samples=8
elapsed_ms=1800
```

Additional raw-byte sanity measurement:

```text
command=node examples/native-messaging/stress-memory.mjs --bytes 67108864 --max-rss-delta-mb 256
wasmtime_version="wasmtime 45.0.0 (377cd917a 2026-05-21)"
mode=raw-bytes
request_body_bytes=67108864
response_frames=64
response_body_bytes=67108864
max_response_frame_body_bytes=1048576
rss_first_mb=3.3
rss_peak_sampled_mb=36.1
rss_peak_hwm_mb=36.1
rss_peak_delta_sampled_mb=32.8
rss_limit_delta_mb=256
rss_samples=3
elapsed_ms=1377
```

Files changed:

- `examples/native-messaging/nm_js2wasm.ts`
- `examples/native-messaging/stress-memory.mjs`
- `examples/native-messaging/README.md`
- `tests/issue-1767.test.ts`
- `plan/issues/1767-native-messaging-64mib-memory-growth.md`

Validation:

- `node_modules/.bin/vitest run tests/issue-1767.test.ts`
- `node_modules/.bin/vitest run tests/issue-1753.test.ts`
- `node_modules/.bin/vitest run tests/issue-1530.test.ts`
- `node examples/native-messaging/stress-memory.mjs --reported-64mib`
- `node examples/native-messaging/stress-memory.mjs --bytes 67108864 --max-rss-delta-mb 256`

## Scope

- Reproduce the 64 MiB native-messaging path with a committed or documented
  stress harness that can run outside normal fast CI.
- Measure wasmtime RSS / linear memory / WasmGC allocation behavior during the
  run and identify whether growth is caused by:
  - retaining all chunks before write,
  - repeated `Uint8Array` / `ArrayBuffer` copies,
  - native-string or typed-array bridge allocations,
  - lack of release points across the long-lived port loop,
  - wasmtime GC/runtime behavior we need to work around or document.
- Keep the protocol chunked and bounded: process one chunk at a time where
  possible, and avoid staging the full 64 MiB response plus per-chunk copies.

## Acceptance

- A reproducible 64 MiB stress run is documented and can be run locally.
- The native-messaging host completes the reported workload without monotonic
  memory growth toward system capacity.
- The issue resolution records a concrete memory budget from the fixed run
  (baseline RSS, peak RSS, and payload size).
- #1753's "memory stays bounded" acceptance criterion is backed by this stress
  proof, not only by smaller chunk-boundary tests.
