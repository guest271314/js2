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
| [#747](747-escape-analysis-for-stack-allocation.md) | Escape analysis for stack allocation (Phase 1 of #652) | hard | #1586, #1587 |

## Theme

**IR foundation for ownership-based optimization.** #1586 introduces stable allocation
identity in the IR, #1587 derives ownership/access semantics, #747 uses those to
scalar-replace non-escaping allocations. #1588 is a separate parallel track on the
same IR foundation (string encoding tracking).

## Notes

- #1586 must land first; #1587, #1588, and #747 all depend on it.
- #1587 is `feasibility: hard` — needs architect spec before dispatch.
- #747 is `feasibility: hard`. Original spec (2026-05-21) targets #743 (whole-program
  analysis) + #746 (shape inference) as dependencies. For sprint 55, the architect
  should re-scope #747 to use the new IR ownership pass (#1587) as its analysis
  substrate — the IR-native path is cleaner than the original AST-walk approach.
- #652 (compile-time ARC, full version) and #746 (inline property tables) remain in
  backlog as larger follow-ups; #747 is the narrower Phase 1.
