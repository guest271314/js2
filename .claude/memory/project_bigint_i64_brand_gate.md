---
name: bigint-i64-brand-gate
description: "BigInt typed-path fixes (#1349/#1644) are gated on an architect i64-bigint-brand ValType decision — not a dev codegen guard"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

BigInt typed-path work (#1349, duplicate of #1644 renumbered_from 1350, parent 1328) is **blocked on an architect representation decision**, not a quick codegen guard.

**Why:** BigInt is lowered as wasm `i64` (`src/codegen/expressions.ts:707`), but `i64` is ALSO the representation for native `type i64 = number` annotations (CLAUDE.md "Native type annotations"). The dominant ~30 of 47 `built-ins/BigInt` fails are i64→externref boxing as a JS *number* not a JS *bigint* (`src/codegen/type-coercion.ts:1408` emits `f64.convert_i64_s`+`__box_number`), so `BigInt("10") !== 10n` in the host `assert.sameValue`. Boxing ALL i64 as bigint would break native i64 numeric code. Distinguishing them needs a bigint-branded ValType (`{kind:"i64",bigint:true}`) threaded through type inference + every coercion site — a cross-cutting choice an architect must ratify. Wasm i64↔JS bigint IS automatic at the import/export boundary (JS-BigInt-integration), so the mechanism exists; the open question is *which* i64s get bigint-boxed.

PR #675 (merged 2026-05-27, docs-only) escalated #1644 to `status: needs-spec` / `feasibility: hard` and explicitly warned: "a type-guard-only patch cannot satisfy the ≥75% acceptance bar and risks regressing native `type i64` code without the brand decision." It documents 4 ordered slices (A: bigint-branded boxing via `__box_bigint`/`__to_bigint`; B: `BigInt(string|number)`; C: `asIntN`/`asUintN`; D: `prototype.toString(radix)`), all gated on the brand.

**How to apply:** If handed #1349 or #1644 as a dev fix, do NOT cut a partial f64-guard. Confirm whether the i64-bigint-brand architect spec has been ratified first; if not, route to `/architect-spec` and only then dev-claim Slice A. Also fold #1349 (stale "add type guards" plan) into #1644 as a duplicate. Related: [[feedback_compile_away]], #1565 (toBoolean bigint i64.eqz), #1526 (bigint+number mixed-arithmetic TypeError).
