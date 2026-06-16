---
id: 1840
title: "Linker writeLEB128 truncates growing indices; call_indirect/memory rewrite gaps"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: low
feasibility: medium
task_type: bugfix
area: link
goal: correctness
sprint: 59
---
# #1840 — linker relocation rewrite defects (latent)

Latent: the `.o` linker is not in the production compile path today.

## Defects
- `src/link/linker.ts:514/533/552` rewrite relocations into the *original* byte
  width; an index originally 1 byte (<128) that resolves to ≥128 is silently
  truncated. Real linkers pad reloc immediates to 5 bytes.
- `call_indirect` (0x11) table index is offset but never `resolveIndex`-resolved
  (`:537`).
- `memory.size`/`memory.grow` (0x3f/0x40) immediate is overwritten as a single raw
  byte — wrong for offsets >127 and assumes 1-byte width.

## Fix
Emit relocatable `.o` immediates at fixed 5-byte width (or re-encode the body when a
rewritten LEB grows); route the table index through `resolveIndex`; rewrite the
memory immediate via read/writeLEB128.

## Resolution
`rewriteCode` (`src/link/linker.ts`) now **re-encodes into a fresh buffer**
rather than patching in place: each rewritten immediate is emitted via a new
`appendLEB128` at its **natural (minimal) width**, copying every non-target byte
verbatim. This is correct regardless of width growth, so an index that was 1 LEB
byte in the input but resolves to ≥128 is no longer truncated. The fixed-width
`writeLEB128` (the source of the truncation) was removed.
- `call_indirect` (0x11): the table index is now routed through `resolveIndex`
  (`SYMTAB_TABLE`) — previously it was only `+ off.tableOffset` and never
  import-resolved.
- `memory.size`/`memory.grow` (0x3f/0x40): the memidx immediate is read as a
  LEB, offset, and re-emitted via `appendLEB128` — previously it was overwritten
  as a single raw byte (wrong for offsets >127).

Latent: the `.o` linker is not in the production compile path today.

### Test Results
- `tests/issue-1840.test.ts` (6, all pass): a 1-byte `call` index grows to 2
  bytes when it crosses 128 (no truncation); `global.get` grows naturally;
  `call_indirect` offsets both type and table indices; `memory.size`/`grow`
  rewrite the memidx as a real LEB; the memory immediate grows past 127
  correctly; non-target opcodes pass through verbatim. A narrow
  `rewriteCodeForTest` export drives the rewriter (empty symbols → `resolveIndex`
  falls through to pure offsetting) without a full multi-module link.
- `tests/object-file.test.ts` (12) green. (`linker-e2e.test.ts` is pre-broken on
  main via an unrelated self-compile `WasmEncoder_i64` error.)

