---
name: project_2984_2988_2992_convergent_reification_substrate
description: "Three independently-discovered standalone gaps (#2984 builtin-object gOPD,"
metadata: 
  node_type: memory
  type: project
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

2026-07-02, three separate Opus devs working unrelated `#2965`-triage follow-ups independently found the same underlying gap:

- **#2984** (builtin-object gOPD, ~178+236 tests): `gOPD(Array.prototype, "forEach")` compiles host-free but returns `undefined` — builtin methods aren't reified as first-class values, and `gOPD(Array, "isArray")` hard-CEs because constructors aren't resolvable dynamic-shape receivers.
- **#2988** (global-object defineProperty, ~10 tests): `Object.defineProperty(globalThis, k, desc)` still leaks `env.__get_globalThis`/`env.__extern_get` — #2907 delivered well-known-global *bare-value carriers*, not an own-property table.
- **#2992** (vec-receiver MOP, ~82+ tests, spun off from #2985): `gOPD` returns `undefined` on array/arguments receivers because vec-backed values have no runtime-queryable descriptor table — every destructive `verifyProperty`/`verifyEqualTo` test262 check fails.

**The common shape:** each receiver class (builtin objects, the global object, vec-backed arrays/arguments) is currently ad-hoc host-backed with no real object-shaped own-property table standalone can query. The existing `__builtinfn_gopd` machinery only answers `name`/`length` on builtin FUNCTION closures — it does not generalize.

**How to apply:** when scoping any of #2984/#2988/#2992's implementation, design ONE reification mechanism (a general own-property descriptor table attachable to any of these receiver classes) rather than three bespoke MOPs. This is likely also connected to #2949's dynamic-IrType work (same D1-disease family, representation-follows-the-value) — read #2984's spec-seed (PR #2523) first, it's the most developed of the three. Route to /architect-spec or a dedicated Fable design session for the unified mechanism before dispatching implementation to three separate devs.
