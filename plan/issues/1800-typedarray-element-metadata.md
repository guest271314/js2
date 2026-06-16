---
id: 1800
title: "TypedArray element metadata for signedness, clamping, and storage"
status: ready
created: 2026-06-03
updated: 2026-06-03
priority: high
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: typedarray
goal: compiler-architecture
sprint: Backlog
related: [608, 1199, 1700, 1767, 1799, 1786, 1787]
---
# #1800 - TypedArray element metadata for signedness, clamping, and storage

## Problem

Current vec keys such as `f64`, `i32_byte`, and `i8_byte` encode too many
separate facts:

- Wasm storage lane (`i8`, `i16`, `i32`, `f32`, `f64`)
- JS constructor kind (`Uint8Array`, `Int8Array`, `Uint8ClampedArray`, ...)
- signed versus unsigned reads
- write coercion / modulo / clamping behavior
- whether values are byte buffers or numeric arrays

The scoped native `Uint8Array` packed-storage fix added necessary `i8` checks,
but a full TypedArray implementation will sprawl if every caller infers
semantics from string keys.

## Proposal

Introduce a typed-array element metadata structure and route constructor,
type-resolution, element access, array methods, host marshalling, and WASI
stream helpers through it.

Candidate fields:

- `constructorName`
- `storageType`
- `valueType`
- `loadOp`
- `signed`
- `clamped`
- `byteWidth`
- `vecKey`

## Acceptance

- Codegen no longer uses ad hoc string-key checks to decide signedness or
  packed load opcode for TypedArray elements.
- `Uint8Array`, `Int8Array`, `Uint8ClampedArray`, `Uint16Array`, and
  `Int16Array` can express distinct semantics while sharing common helper code.
- Existing `ArrayBuffer` / `DataView` `i32_byte` backing behavior remains
  separate and documented.
- The metadata is used by at least constructor lowering, `resolveWasmType`,
  element access, typed-array `.set`, and `process.std*.write` lowering.

## Non-goals

- Implementing every typed-array constructor in the same PR. This issue is the
  representation cleanup that makes #1799 tractable.
