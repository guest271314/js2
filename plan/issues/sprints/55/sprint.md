---
sprint: 55
status: planning
created: 2026-05-23
---

# Sprint 55 Plan

## Issues

| ID | Title | Feasibility | Depends on |
|----|-------|-------------|------------|
| [#1586](1586-explicit-allocation-sites-in-ir.md) | IR preparation: explicit allocation sites with stable identity and metadata hooks | medium | — |
| [#1587](1587-ownership-and-access-semantics-analysis.md) | Static analysis pass: ownership and access semantics on IR values | hard | #1586 |
| [#1588](1588-string-encoding-tracking-utf8-wtf16.md) | String encoding tracking: prove UTF-8 guarantees for zero-copy Component Model interop | medium | #1586 |

## Notes

- #1586 must land first; #1587 and #1588 both depend on it.
- #1587 is `feasibility: hard` — needs architect spec before dispatch.
