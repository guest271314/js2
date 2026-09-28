---
id: 6733
title: "standalone: three.js stops at a program-ABI invariant — inherited class-instance getter alias disagrees with its canonical signature"
status: ready
sprint: Backlog
created: 2026-09-28
updated: 2026-09-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [1599, 6667]
---

# #6733 — three.js standalone: inherited getter alias signature mismatch

## Problem

Surfaced by [#1599](https://js2wasm.loopdive.com/dashboard/issue.html?slug=1599-json-standalone)
Phase 2: once `JSON.stringify(groups)` in `BufferGeometry.toJSON` compiles in
standalone, the three 0.185.1 standalone-dynamic lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only three --no-write --perf-only --lane standalone-dynamic`,
~400 s to the error) stops at a program-ABI invariant instead of the JSON
refusal:

```
Codegen error: inherited class callable ir-class:v1:…three.core.js:root:declaration:0000000000000010 /
ir-unit:v1:…three.core.js:ir-class%3A…declaration%3A0000000000000009:class-instance-getter:0000000000000001
disagrees with its exact canonical signature (at src/codegen/program-abi-class-callable-planning.ts:823:17)
```

The throw is the `alias-signature-mismatch` invariant: the child class
(declaration 16) inherits a getter from declaration 9, and the canonical, the
alias draft and the live function do not share one callable type contract.

## Evidence that #1599 did not cause it

A/B on the #1599 branch with the only class-touching part of that change (the
`__get_member_toJSON` reservation) disabled produced the identical diagnostic.
The rest of #1599 adds runtime helper functions only. On the parent the
compile never reached this pass: codegen refused `JSON.stringify` first.

## Next steps

- Reduce: extract declarations 9 and 16 of `build/three.core.js` (the first
  inheriting class pair with an instance getter) into a two-class fixture and
  compile it `--target standalone`.
- Compare the three signatures at the throw site (`canonicalSignature`,
  `aliasSignature`, `liveSignature`) — the comment above the check names the
  `super.value` getter receiver `ref 14` vs `ref 1` remap as a known hazard.

## Acceptance criteria

- The reduced fixture compiles standalone and the getter returns the base
  value through the subclass.
- The three standalone-dynamic lane moves past this invariant (record the next
  error here).
