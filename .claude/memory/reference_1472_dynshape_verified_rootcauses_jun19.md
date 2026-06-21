---
name: reference_1472_dynshape_verified_rootcauses_jun19
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#1472 standalone dynamic-shape object/property cluster, re-measured against fresh standalone baseline (loopdive/js2wasm-baselines test262-standalone-current.jsonl, 2026-06-19 08:15, 22,881 pass). Report buckets (faithful ordered matchers from scripts/build-test262-report.mjs): standalone-dynamic-object-property 3050, object-property-semantics 1921, object-to-primitive 659, standalone-reflect-refusal 316.

**Dominant addressable lever = ToPrimitive ("Cannot convert object to primitive"), ~3256 non-Temporal rows** (2322 more are Temporal, out-of-scope, claimed by earlier bucket). Verified by probe (npx tsx against src `compile(...,{target:"standalone"})`) — the failures are WRONG-VALUE/trap, NOT compile-error:
- `o + 1` (valueOf)→8 ✓, `o-2`→7 ✓, `o<10`→1 ✓, `{}+"!"`→"[object Object]!" ✓, `{toString:()=>"X"}+"!"`→"X!" ✓ — emitAnyAdd §13.15.3 arm (binary-ops.ts L3041) WIRED. (NOTE: an earlier probe read `undefined` for string-concat but that was a string-RETURN marshalling artifact, NOT a bug — confirmed via .length/=== probes. Do NOT spec string concat.)
- `o == 5` (obj valueOf) / `"1" == new Boolean(true)` → **0** ✗ = R1 (dispatched task #77): loose-eq §7.2.15 Object↔primitive arm MISSING (binary-ops.ts ~L2001 noJsHost dispatch handles num/bool/bigint/string/identity, never calls __to_primitive on an object operand). TOP LEVER ~600-900.
- `obj[k]` computed key with valueOf → **illegal cast** ✗ = R2 (=06-17 S1, #2042 PR-B-pre): __obj_find/__obj_hash unconditional ref.cast $AnyString.
- `Number(new Boolean(true))`→0, `new Boolean(true).valueOf()`→0 ✗ = R3 (task #78): __new_Boolean (object-runtime.ts L1085) stores a boxed f64 not boxed bool.
- `new String("ab")[0]`→0, `new String("xy").length`→null-deref ✗ = R4 (task #79): String-wrapper indexing not routed to the slot string.
- `class A extends Error{code;ctor{super();this.code=42}}; class D extends A{}; new D().code`→0 ✗ = R5 (#2101): see below.

KEY: __to_primitive native (object-runtime.ts L1917) IS fully built incl boxed-wrapper slot read (WRAPPER_PRIMITIVE_KEY/FLAG_INTERNAL, L2083). __new_Number/String/Boolean native builders exist + in OBJECT_RUNTIME_HELPER_NAMES (ensureLateImport L377 auto-routes to native under standalone). So producer+consumer exist — the gap is CONSUMER CALL SITES. See [[reference_2358_toprimitive_nominal_struct_path]]. Spec landed as tasks #77(R1)/#78(R3)/#79(R4); R2→#2042; R5→#2101.

R5 own-field rep (#2101/#48, via sdev-protoglue): externref-backed subclass own fields dropped. Bail: class-bodies.ts ~L1674 emitOwnInstanceFieldInitializers skips externref-backed classes (#1366a). $Error_struct (registry/error-types.ts) = tag/message/name/stack/userClassId, no user-field slot; whole classExternrefBackedSet affected. FIX (unify, don't bespoke): reuse LANDED open-$Object runtime via lazy `props: ref null $Object` field; stop bailing, route own get/set through __obj_set/__obj_get. #2188 multi-level instanceof+message DONE (PR #1713). Infra-ready, LOW priority. Hazard: register $Error_struct all-fields-up-front (no mid-collection push — [[project_type_index_shift_and_deadelim]]).

Out-of-scope (route elsewhere, NOT #1472 dynshape): built-in static-property value reads (Symbol.iterator/BYTES_PER_ELEMENT/X.prototype) → #1907/#2158; __get_builtin (388) → #2158; Temporal → #661; Reflect.construct (135, hard) → #2046/#2026.
