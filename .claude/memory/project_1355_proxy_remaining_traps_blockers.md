---
name: project-1355-proxy-remaining-traps-blockers
description: "#1355 standalone Proxy: 5 traps landed; the remaining 4 are each blocked on separate standalone infrastructure"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#1355 (pure-Wasm Proxy remaining traps, standalone) — status as of 2026-06-18.

**Landed (clean front-guard pattern, all merged to upstream/main):** deleteProperty
(#1655/Slice A), getOwnPropertyDescriptor (#1662/B), getPrototypeOf+setPrototypeOf
(#1663/C), isExtensible+preventExtensions (#1664/D). 6 trap fields total on
`$ProxyTraps`, each = struct field (appended, base indices preserved) +
`__proxy_<trap>_dispatch` helper + reserve-then-fill driver through the #1100
`__apply_closure` bridge + `ref.test $Proxy` front-guard on the matching native
helper (`__delete_property`, `__getOwnPropertyDescriptor`, `__getPrototypeOf`,
`__object_setPrototypeOf`, `__object_isExtensible`, `__object_preventExtensions`).
Builders: `buildDispatch` (key-traps), `buildProtoDispatch` (no-key proto traps),
`buildExt1Dispatch` (1-arg boolean ext traps).

**The remaining 4 traps are each blocked on SEPARATE standalone infrastructure
(NOT proxy-dispatch work) — validated by probe:**
- **ownKeys** — front-guard fixes the latent no-trap bug (`Object.keys(proxy)` was
  `ref.cast $Object`-ing a `$Proxy` to empty; now forwards to target). BUT the
  trap-present path can't marshal the trap's returned array: `__extern_length`
  reads 0 on a standalone `$Array` (array literals lose length through the
  externref boundary — even `function(){return ["a","b"]}` then `.length`===0
  standalone), and `$ObjVec` `[i]` indexing + `getOwnPropertyNames` are gappy.
  Needs the standalone `$Array`/`$ObjVec` introspection layer. (TaskList #34)
- **defineProperty** — static `Object.defineProperty(p,k,{value})` lowers via
  compile-time descriptor expansion that writes the object struct directly (no
  single front-guardable helper); dynamic-descriptor (`__defineProperty_desc`)
  and `Reflect.defineProperty` both hard-error standalone (#1472 Phase B/C).
  (TaskList #33, blocked on #1472)
- **apply** — ATTEMPTED 2026-06-18, backed out. Built `__proxy_apply_dispatch`
  (clean: reuses `__apply_closure` + a `$ObjVec` args vec, no `$Array` needed —
  the lead was right it doesn't touch the array layer) and hooked the graceful
  fallback + the `ref.test`-guarded closure fallback else-branch
  (`calls.ts:~11620`). DID NOT FIRE: `p:any = new Proxy(...)` then `p(5)` is
  routed by TS call-signature inference through the **identifier
  inferred-signature closure dispatch at `calls.ts:~9135`**
  (`getOrCreateFuncRefWrapperTypes` block), whose `ref.test (closure-wrapper)`
  is false for a proxy → that dispatch's OWN else emits `ref.null.extern` →
  returns 0, never reaching my hooks. So apply needs a shared
  "is-this-externref-a-$Proxy?" else-branch factored into EVERY closure-dispatch
  site (9135 + the multi-funcref/async-candidate/Promise variants) — a
  coordinated multi-site change in the 12k-line call machinery, architect-scale,
  NOT a contained slice.
- **construct** — `new proxy(...)` pulls in a host env import; entangled with the
  #2026 dynamic-new ctor ABI (owned by another senior-dev).

**Takeaway:** the front-guard-on-native-helper pattern only works for traps whose
operation routes through ONE native helper that sees the proxy externref. The 4
remaining traps either have no such single helper (defineProperty, apply) or hit
the standalone `$Array`/`$ObjVec` boundary (ownKeys, apply argsList) or another
epic (construct→#2026). See [[feedback_compile_away]] — these need the standalone
array/descriptor layer built first, not more trap plumbing.
