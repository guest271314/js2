---
id: 1779
title: "WIT generator wasm-tools round-trip parity check"
status: ready
created: 2026-06-02
updated: 2026-06-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: test
area: wit-generator
language_feature: wit
goal: platform
sprint: Backlog
related: [389, 600, 639, 1751]
origin: "Follow-up to #1751 stretch goal: wasm-tools round-trip parity check was not implemented because wasm-tools was unavailable in the workspace."
---
# #1779 - WIT generator wasm-tools round-trip parity check

## Problem

#1751 fixed the required WIT generator surface for package names and function
imports, and it closed the GitHub #389 report's immediate WIT output gap. The
stretch validation was not added: there is still no automated check that our
emitted WIT stays in parity with WIT extracted by `wasm-tools component wit`.

Without a round-trip parity check, future WIT generator changes can drift from
component-tooling output while still passing local string snapshot tests.

## Acceptance

- Add a stable dev/CI path for running `wasm-tools`, either by provisioning a
  known version or by documenting and gating an explicit unavailable state.
- Compile a small WASI/native-messaging-shaped program with `--wit`.
- Build or inspect the generated artifact in the same shape used by the
  component-model tooling path.
- Compare our emitted WIT against `wasm-tools component wit` output modulo
  formatting and documented canonical differences.
- Keep the existing #1751 WIT generator tests passing.

## Non-goals

- Implementing full component adapter generation or canonical ABI wrapping;
  that remains #639.
- Reworking the WIT generator beyond the parity surface needed for the test.
