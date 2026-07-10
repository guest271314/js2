---
name: feedback_north_star_ir_first
description: "North star (user, 2026-07-02) — route EVERYTHING through the IR front-end; backends (WasmGC vs linear) differ only at lowering."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**North star (user directive, 2026-07-02):** route everything through the IR (`src/ir/`); the two backends (WasmGC `src/codegen/`, linear `src/codegen-linear/`) should differ ONLY at lowering. Legacy direct AST→Wasm is to be retired, not maintained.

**Why:** the always-available legacy body is the mechanism that makes silent IR fallback free (#1530); duplicate front-end paths breed the drift diseases (D4) documented in the June Fable audit (`plan/log/analysis-2026-06/00-program-overview.md`).

**How to apply:** prioritize the IR cluster as P1 when choosing "hardest tasks": #2138 (compile-once inversion — keystone, spec dev-ready, was parked only on Fable availability) → #2135 (single IR capability predicate) → #2855 ratchet buckets to zero (#2856-#2859) → #1916 (symbolic func refs). New feature work should prefer extending the IR path over adding legacy-path special cases.

**July 2026 update:** the current program-level plan is `plan/log/analysis-2026-07/00-ir-async-standalone-audit.md` (supersedes the June series for sequencing; June reports 00-08 remain the disease taxonomy). Its keystones, all filed: #2949 (dynamic/JsTag IrType — the TRUE critical path; without it the IR claim rate stays single-digit at test262 scale), #2950 (IR-first default flip), #2953 (BackendEmitter pushRaw gap), #1042 re-scoped (host async onto the #2906 N-state machine, BEFORE #1373b), #2962 (native error identity — best standalone dispatch). Stakeholder emphasis 2026-07-02: close the standalone gap (15,376 tests, honest metric) + dynamic features (promises/eval/new Function) in standalone.
