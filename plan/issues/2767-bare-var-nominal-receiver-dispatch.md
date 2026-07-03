---
id: 2767
title: "nominal value assigned into an uninitialized/untyped var loses its type → method dispatch goes dynamic and fails (var d; d = new Date(0); d.toISOString())"
status: done
sprint: 69
priority: high
assignee: ttraenkler/agent-dev
completed: 2026-06-28
created: 2026-06-28
updated: 2026-07-03
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: methods, dynamic-dispatch, type-flow
goal: spec-completeness
related: [2151, 2015, 1888, 1030, 1022, 2660, 2671]
horizon: m
origin: "2026-06-28 dev-rescue root-cause of the Date toISOString test262 residual; architect-specced (#2767)."
---

# #2767 — bare-`var` nominal receiver loses its type → method dispatch goes dynamic and fails

## Problem

A nominal value assigned into an **uninitialized / untyped** `var`/`let` binding
loses its nominal type, so method dispatch on it falls to the generic dynamic
path and fails. Verified repros on current main (host mode):

```ts
const d = new Date(0);
d.toISOString(); // "…Z" ✓ (typed binding)
var d;
d = new Date(0);
d.toISOString(); // ✗ "toISOString is not a function"
var d: any;
d = new Date(0);
d.toISOString(); // ✗ same
var d, x;
d = new Date(0);
d.toISOString(); // ✗ same
var d;
if (true) {
  d = new Date(0);
}
d.toISOString(); // ✗ same
let d;
d = new Date(0);
d.toISOString(); // ✗ same
```

This is a **residual of the already-DONE dispatch infra** #1888 / #1030 / #1022 /
#2151 (do NOT re-open those — the base any-receiver vtable path is closed). The
residual is purely the _type-flow_ gap: a binding declared without an initializer
and without an annotation is typed `any`/externref by the TS checker, and the
nominal-receiver method dispatch never engages for it.

It is the same class that makes the ~11 Date `toISOString` bare-`var` test262
cases fail and is the structural fix for the broader `var x; x = new Foo();
x.method()` pattern across test262.

## Root cause (exact)

The whole method-call dispatch hub keys on the **static** receiver type's nominal
symbol:

- `src/codegen/expressions/calls.ts:8746` —
  `const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);`
- `src/codegen/expressions/builtins.ts:1361-1362` (`compileDateMethodCall`):
  ```ts
  const symName = receiverType.getSymbol()?.name;
  if (symName !== "Date") return undefined; // ← bails for any/externref
  ```

The SAME `receiverType.getSymbol()?.name` gate guards Date, DataView
(`calls.ts:8825`), ArrayBuffer (`8850`), TextEncoder/TextDecoder (`8752`),
`isExternalDeclaredClass` (`8859`), generators (`8866`), the Number/String/Boolean
wrappers (`9028`), RegExp and Map/Set. For a bare-`var` receiver every one of
these gates fails, so the call drops to generic dynamic dispatch
(`__extern_method_call`), and in host mode the runtime throws
`<method> is not a function` (`src/runtime.ts:10015`) because the receiver is a
raw WasmGC struct the host method table doesn't know.

**Why the checker can't help (measured, not assumed).** Probing the real TS
checker with the project lib (`.tmp/probe-checker2.mjs`):

| source                                    | `getTypeAtLocation(recv)` | symbol |
| ----------------------------------------- | ------------------------- | ------ |
| `const d = new Date(0); d.toISOString()`  | `Date`                    | `Date` |
| `var d; d = new Date(0); d.toISOString()` | `any`                     | (none) |
| `var d: any; …`                           | `any`                     | (none) |
| `var d; if(true){ d = new Date(0);} …`    | `any`                     | (none) |
| `let d; d = new Date(0); …`               | `any`                     | (none) |

TS's "evolving-any" narrowing does **not** propagate the assigned `Date` type to
the later `d.toISOString()` receiver — it reports `any`. So the fix must live in
the **compiler**, by scanning the binding's assignments syntactically (the same
technique already used by `symbolBindsAsyncFunction` at
`src/codegen/expressions.ts:262`).

**The value-recovery half already works.** When the bare-`var` slot is externref
and held `new Date(0)` (stored via `extern.convert_any` of the `$Date` struct),
`coerceType(externref → ref $Date)` already emits `any.convert_extern` +
`ref.test`/`ref.cast` (`src/codegen/type-coercion.ts:1466`). And
`compileDateMethodCall` already compiles its receiver _with the expected
`dateRefType`_ (`builtins.ts:1422`), so the recovery fires automatically once the
dispatch decision is made. The Date struct is the same GC object across the
externref roundtrip in both modes — confirmed: the current failure is the host
`__extern_method_call` receiving that very struct.

## Verification (experiment performed, then reverted)

A throw-away patch at `calls.ts:8746` that recomputes `receiverType` from the
binding's consistent assignment-RHS type made **all** repros pass with **no other
change** (the existing `compileDateMethodCall` + `coerceType` did the rest), and
did not regress generic any-object-literal dispatch:

- `const d = new Date(0)` ✓ (unchanged)
- `var d; d = new Date(0)` ✓
- `var d: any; d = new Date(0)` ✓
- `var d; if (true) { d = new Date(0); }` ✓
- `var d; d = new Date(1000); d = new Date(0)` ✓ (reassign same type)
- `var d, x; d = new Date(0)` ✓
- `const o: any = { getx() { return 7 } }; o.getx()` ✓ (no regression)

This confirms the fix is a single dispatch-decision change; no new Wasm-emission
logic is required.

## Implementation Plan

### Root cause (1 line)

A `var`/`let` declared without initializer/annotation is typed `any` → externref,
so the nominal-symbol gate at the method-call dispatch hub bails to dynamic
dispatch even though the slot demonstrably holds a single nominal struct.

### Change — add a syntactic "assigned nominal type" recovery and feed it into the dispatch hub

**File: `src/codegen/expressions/calls.ts`**

1. Change line 8746 from `const receiverType` to `let receiverType`.

2. Immediately after it, when the static receiver type resolves **no** nominal
   symbol and the receiver is a bare identifier, recover an effective nominal
   `ts.Type` and substitute it:

   ```ts
   let receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
   if (!receiverType.getSymbol()?.name && ts.isIdentifier(propAccess.expression)) {
     const recovered = resolveAssignedNominalType(ctx, propAccess.expression);
     if (recovered) receiverType = recovered;
   }
   ```

   Substituting `receiverType` wholesale is correct: every downstream gate
   (Date, DataView, ArrayBuffer, `isExternalDeclaredClass`, `isGeneratorType`,
   wrappers, …) then sees the true nominal type, and Date already runs _before_
   the extern-class dispatch, so ordering is preserved.

3. New helper (put it near the other receiver helpers in this file, e.g. next to
   `isNumberMethodReceiver` ~line 768; or in a small shared module if you prefer):

   ```ts
   /**
    * (#2767) Recover the nominal `ts.Type` a bare-`var`/`let` identifier holds
    * when the TS checker reports `any` (no annotation, no initializer — the
    * "evolving-any" case the checker does NOT narrow across statements).
    *
    * Conservative-closed: returns a type ONLY when the binding's initializer (if
    * any) AND every `<ident> = <rhs>` assignment to the same binding symbol in
    * the source file resolve to the SAME nominal symbol. Any divergence, any
    * RHS that resolves to no nominal symbol, or zero assignments ⇒ undefined
    * (keep the existing dynamic path — never a wrong struct). Mirrors the
    * symbol-scan in `symbolBindsAsyncFunction` (expressions.ts:262).
    */
   function resolveAssignedNominalType(ctx: CodegenContext, ident: ts.Identifier): ts.Type | undefined {
     const sym = ctx.checker.getSymbolAtLocation(ident);
     if (!sym) return undefined;
     const rhsTypes: ts.Type[] = [];
     for (const d of sym.declarations ?? []) {
       if (ts.isVariableDeclaration(d) && d.initializer) {
         rhsTypes.push(ctx.checker.getTypeAtLocation(d.initializer));
       }
     }
     const sf = ident.getSourceFile();
     const visit = (n: ts.Node): void => {
       if (
         ts.isBinaryExpression(n) &&
         n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
         ts.isIdentifier(n.left) &&
         ctx.checker.getSymbolAtLocation(n.left) === sym
       ) {
         rhsTypes.push(ctx.checker.getTypeAtLocation(n.right));
       }
       ts.forEachChild(n, visit);
     };
     visit(sf);
     if (rhsTypes.length === 0) return undefined;
     let name: string | undefined;
     for (const t of rhsTypes) {
       const nm = t.getSymbol()?.name;
       if (!nm) return undefined; // a non-nominal RHS (any / number / …) → bail
       if (name === undefined) name = nm;
       else if (name !== nm) return undefined; // divergent nominal types → union → bail
     }
     // Optional extra guard: only accept names this backend lowers natively /
     // has a struct for — a native builtin (Date/RegExp/DataView/ArrayBuffer/
     // Map/Set/TypedArray) OR `ctx.structMap.has("__fnctor_"+name)` /
     // `ctx.structMap.has(name)`. Skipping this guard is still SAFE (a name with
     // no matching gate just falls through to the existing dynamic path), so it
     // is a precision/perf refinement, not a correctness requirement.
     return rhsTypes[0];
   }
   ```

### Wasm IR pattern

No new emission. The dispatch decision change reuses:

- `compileDateMethodCall` receiver compile with `dateRefType`
  (`builtins.ts:1422`), and
- `coerceType` externref→ref struct (`type-coercion.ts:1466`):
  ```wasm
  local.get $d            ;; externref slot holding extern.convert_any($Date)
  any.convert_extern      ;; → anyref
  ref.test $Date          ;; (already emitted by coerceType)
  ;; if true: ref.cast $Date  → struct.get for getTime/toISOString/…
  ```

### Edge cases (all verified in the experiment)

- **Reassignment, same type** (`d = new Date(); d = new Date()`) → still one
  nominal symbol → engages. ✓
- **Conditional assignment** (`if (c) d = new Date()`) → engages (the slot can
  only hold a `$Date` or null). ✓
- **Multiple decls** (`var d, x;`) → engages on `d`. ✓
- **Divergent nominal types** (`if (c) d = new Date(); else d = /x/;`) → union →
  helper returns undefined → stays dynamic (today's behavior; no misdispatch).
- **Nominal mixed with non-nominal** (`d = new Date(); d = 5;`) → a RHS with no
  nominal symbol → bail → dynamic. **This is the load-bearing safety rule**: only
  emit the nominal hint when EVERY assignment agrees, so the externref→ref cast
  can never see a value that isn't that struct.
- **Use-before-assignment** (`var d; d.toISOString()` with no assignment) → zero
  RHS → returns undefined → unchanged (dynamic / current behavior). A slot read
  before any assignment is null externref; if a guarded nominal path were ever
  reached on null it would trap rather than throw a JS TypeError — acceptable and
  pre-existing, and this change does not introduce it (zero-assignment ⇒ no hint).
- **`@@toPrimitive` / generic-receiver cases dev-rescue flagged → OUT OF SCOPE.**
  Those are a _different_ gap (generic method protocol on an any receiver, not the
  bare-`var` type-flow). Keep them on their own issue; do not fold them here.

### Scope note (follow-on, not required for the toISOString win)

This spec fixes the **call** dispatch hub (`compileCallExpression` member-call
path). Property **reads** (`d.field`) and **writes** (`d.x = …`) on a bare-`var`
nominal receiver compute their own `receiverType` in the member-get / member-set
dispatch and would still go dynamic. They are not needed for the Date method
cluster; if a follow-on wants them, route the same `resolveAssignedNominalType`
recovery through `member-get-dispatch.ts` / `member-set-dispatch.ts`. Track as a
separate slice — do not expand this issue's blast radius.

### Performance

`resolveAssignedNominalType` walks the source file once per _bare-var_ receiver
(gated behind the cheap `!getSymbol()?.name` check, so it runs only for the rare
any-typed identifier receiver — exactly as `symbolBindsAsyncFunction` already
does). If a hot file shows up, memoize per binding-symbol on a
`ctx`-scoped `Map<ts.Symbol, ts.Type | null>`; not required for correctness.

## Impact (measured)

- **Direct, high-confidence:** the **11** `built-ins/Date/prototype/toISOString/*`
  bare-`var` cases (`grep -lE '^var date' …/toISOString` = 11; the cluster takes
  the UTC `else` branch → `date.toISOString()` "Z" check) plus the **4** other
  Date-prototype bare-`var` cases. ⇒ **~10-15 test262 cases**.
- **Structural / broader:** a whole-test262 heuristic (`var <id>;` + `<id> = new
X(` + `<id>.method(`) matches **105 files**, top constructors DataView (43),
  TypedArray (41), Date (4), ArrayBuffer/SharedArrayBuffer, Intl. Many `TA`/`DV`
  hits are _constructor-aliases_ (not instance dispatch) or are blocked by other
  gaps, so treat 105 as the upper envelope, not the realistic count — but it
  confirms the pattern is broad and this is the right structural place to fix it.

## Classification

- **Dev-tractable after this spec.** Single localized change (one helper + a
  2-line substitution at the dispatch hub), reusing two existing mechanisms
  (`coerceType` externref→ref, `compileDateMethodCall`). No new Wasm emission, no
  index-shift / late-import hazards.
- **Broad-impact: YES.** The substituted `receiverType` flows into ~10 dispatch
  gates, so a regression could surface anywhere a bare-`var`/`let` is a method
  receiver. **Validate on full CI / `merge_group`, not a scoped sweep.** The
  conservative all-assignments-agree rule keeps the blast radius to "an
  any-typed identifier with a single consistent nominal across all its
  assignments," which is precisely the currently-broken set.

## Acceptance criteria

1. All five repros above return the correct `toISOString()` value in host mode.
2. `built-ins/Date/prototype/toISOString` bare-`var` cases flip pass.
3. No regression in generic any-receiver dispatch (`const o: any = { m(){…} };
o.m()`), in typed-receiver dispatch, or in the standalone any-receiver path
   (#2151).
4. Full-CI / `merge_group` green (broad-impact).

## Resolution (agent-dev, 2026-06-28)

Implemented exactly as specced. `src/codegen/expressions/calls.ts`:

- Added `resolveAssignedNominalType(ctx, ident)` (next to `isNumberMethodReceiver`)
  — mirrors `symbolBindsAsyncFunction`'s symbol-scan; returns the shared nominal
  `ts.Type` only when the binding initializer + every `<ident> = <rhs>`
  assignment agree on one nominal symbol; bails (undefined) on a non-nominal RHS,
  divergent symbols, or zero assignments.
- At the call-dispatch hub (`const receiverType` → `let receiverType`), when the
  static type resolves no nominal symbol and the receiver is a bare identifier,
  substitutes the recovered type so the downstream Date/DataView/ArrayBuffer/
  RegExp/wrapper gates engage.

Validation (host mode, current main base):

- All 11 acceptance repros pass (`tests/issue-2767.test.ts`), incl. DataView
  generalization and the divergent-bail + generic-any-object no-regression guards.
- Date.prototype test262 sweep (485 files): fail 26 → 24 on the identical base
  (clean `calls.ts` vs fix), **+2 flips** (`toISOString/15.9.5.43-0-11`, `-12`),
  **zero regressions** (empty newly-failing diff). The broader DataView/
  ArrayBuffer/RegExp bare-`var` envelope is measured by full CI / merge_group.

Property **reads/writes** on a bare-`var` nominal receiver (`d.field`, `d.x = …`)
remain dynamic — out of scope per the spec's scope note (separate follow-on
through `member-get-dispatch.ts` / `member-set-dispatch.ts`).

## merge_group regression → Date-only safelist (agent-dev, 2026-06-28)

The first PR (#2228) passed all PR-level checks + the scoped Date sweep but
**failed the `merge_group` test262 regression gate**: 6 regressions / 5
improvements (net -1). The merged-state delta showed the substitution is unsound
for NON-Date receivers — exactly the broad-impact risk of substituting
`receiverType` across ~10 dispatch gates:

| regressed file | category | cause |
| --- | --- | --- |
| Promise/prototype/finally/{rejected,resolved}-observable-then-calls-PromiseResolve | illegal_cast ×2 | recovered closure receiver → unguarded `ref.cast` |
| language/literals/regexp/y-assertion-start (`re.test`) | assertion_fail | native RegExp dispatch on recovered receiver returns wrong value |
| SharedArrayBuffer/prototype/grow/this-is-not-resizable | assertion_fail | `.grow()` native path skips the TypeError |
| language/expressions/super/call-spread-obj-spread-order | wasm_compile | invalid Wasm in the recovered super-spread path |
| DisposableStack/prototype/dispose/throws-error-as-is… | assertion_fail | recovered dispatch path partial |

All **5 improvements were Date** (`toISOString` ×2, annexB `setYear` ×3); **all 6
regressions were non-Date**. Fix: the architect's "optional extra guard" is now
**required** — `resolveAssignedNominalType` gates on
`SAFE_BARE_VAR_RECOVERY_NOMINALS` (Date only) plus a var/let-only declaration
rule (excludes parameters/closure bindings — the Promise.finally illegal-cast
driver). With Date-only every non-Date receiver reverts to the exact pre-#2767
dynamic path (= baseline pass), so the measured net is **+5 / 0 regressions**.

Re-validated: all 11 acceptance tests pass; the 6 previously-regressed test262
files all pass; the 5 Date improvements all pass; Date.prototype sweep fail 26 →
24 with an empty newly-failing diff vs clean baseline.

**Per-type safelist expansion** (harden each nominal's externref→ref recovery,
then add it to the safelist, validated per-type via full CI / merge_group) is
tracked on **#2768** — the 6 regressing files above are the exact per-type
recovery bugs to fix.
