---
id: 3312
title: "Nested-class/obj-literal capture promotion mis-binds a shadowed outer local — method body and sibling closures diverge onto two storages"
status: ready
sprint: Backlog
priority: medium
feasibility: hard
task_type: bug
area: codegen
language_feature: closures, classes, scoping
goal: correctness
horizon: m
related: [3132, 1161]
created: 2026-07-16
origin: "#3132 S2 corpus scan — the test262 dstr `ary-elision-iter` template exposed it once async-gen method modules kept the native carrier (callbacks actually ran)."
---

# #3312 — capture promotion vs shadowed binding: two storages for one JS variable

## Problem

When a class (or object literal) is nested inside a function whose local `x`
SHADOWS a module-scope declaration of the same name, the class-METHOD body's
reference to `x` resolves to the MODULE-scope global, while sibling closures
(e.g. a `.then` arrow in the same function) capture the shadowing
function-local (ref cell / promoted copy). One JS binding, two Wasm storages —
writes from the method body are invisible to the arrow and vice versa.

Repro (fails on the DEFAULT JS-host lane today — `finalFail=2`):

```ts
let callCount: number = 0; // module-scope (the wrapper hoists this)
export function test(): number {
  var callCount = 0; // shadows the module binding
  class C {
    async *method() {
      assert_sameValue(callCount, 0); // reads MODULE global (wrong binding)
      callCount = callCount + 1; // writes MODULE global
    }
  }
  new C().method().next().then(() => {
    assert_sameValue(callCount, 1); // reads the fn-local capture -> still 0 -> FAIL
  }).then($DONE, $DONE);
  ...
}
```

test262 hits this via the dstr `ary-elision-iter` template family (~16 files):
the source declares `var callCount = 0;` TWICE; the test-runner wrapper hoists
one copy to module scope and leaves the other inside `test()` — producing
exactly the shadowing shape. On the standalone lane the failure was masked
because those modules' `.then` callbacks never executed (host-stub Promise);
#3132 S2's carrier flip would have exposed it, so the S2 pre-pass
(`methodBodyRefsShadowedOuterLocal`, src/codegen/closures.ts) conservatively
keeps such modules on the host Promise pipeline. Fixing THIS issue allows
removing that guard and flips the ~16 files to genuine host-free passes.

## Root cause sketch

The nested-class capture promotion (#1161 promote-captures-to-globals) keys the
promoted storage by NAME; when a module-scope global with the same name already
exists, the method body binds the module global instead of a fresh promoted
copy of the shadowing local. The closure-capture path (ref cells) resolves the
local correctly — so the two consumers of the same binding disagree.

## Acceptance

- The repro above passes on the JS-host lane (`finalFail=0`).
- Removing `methodBodyRefsShadowedOuterLocal` from the #3132 S2 carrier
  pre-pass leaves the dstr `ary-elision-iter` family passing host-free.
- No regression in the class/dstr + expressions/object/dstr clusters.
