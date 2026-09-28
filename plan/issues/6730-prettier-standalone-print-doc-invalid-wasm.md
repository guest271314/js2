---
id: 6730
title: "prettier standalone-dynamic lane: `Ce` (printDocToString) emits invalid Wasm — `struct.get[0] expected type (ref null N), found if of type f64`"
status: ready
sprint: current
created: 2026-09-28
updated: 2026-09-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone-mode
---

## Problem

With the #680 prettier generator shapes lowered natively (2026-09-28), the
prettier `standalone-dynamic` lane gets past codegen and fails on validation:

```
wasm-opt -O4 did not produce the measured artifact: wasm-opt -O4 failed: [parse exception: invalid type on stack (at 0:805877)]
```

V8 names the function:

```
CompileError: WebAssembly.compile(): Compiling function #379:"Ce" failed: struct.get[0] expected type (ref null 314), found if of type f64 @+805849
```

`Ce` is prettier 3.8.1 `standalone.mjs`'s `printDocToString`
(`function Ce(e,t){let u=Object.create(null),r=t.printWidth,…`). Somewhere in
it a value-producing `if` typed `f64` feeds a `struct.get` on a struct ref — a
conditional/branch result whose arms were unified to f64 while the consumer
still expects the struct carrier.

**Not caused by #680.** Measured on main `2e23e49fb1` with the three prettier
generators (`be`, `Cr`, `Ko`) replaced by plain `return []` stubs: the same
function fails the same way (`… found if of type f64 @+802640`). It was
hidden behind the #680 generator refusal, which aborted compilation first.

## Reproduce

```bash
npx tsx scripts/generate-npm-compat-report.mjs --only prettier --no-write --perf-only \
  --lane standalone-dynamic --inspect-binary .tmp/prettier.wasm --preserve-debug-names
node -e 'WebAssembly.compile(require("fs").readFileSync(".tmp/prettier.wasm")).catch(e=>console.log(String(e)))'
```

## Acceptance

- The lane's unoptimized binary validates; the lane reports the next blocker
  (or a measured perf row).
- A reduced regression test for the offending expression shape, failing on
  the parent and passing with the fix.
