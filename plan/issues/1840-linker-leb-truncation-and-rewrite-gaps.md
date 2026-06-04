---
id: 1840
title: "Linker writeLEB128 truncates growing indices; call_indirect/memory rewrite gaps"
status: ready
created: 2026-06-04
updated: 2026-06-04
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

