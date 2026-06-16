---
id: 685
title: "Interprocedural type flow: track return types across call sites"
status: done
created: 2026-03-20
updated: 2026-06-03
completed: 2026-06-03
resolution: done-by-existing-infra
resolution_note: "getWasmFuncReturnType (call sites use actual Wasm return type) + #1121 inferNumericReturnTypes already implement the ask; the residual implicit-any-ref-return extension is benefit-neutral (call-site re-boxes to externref) and unsound for class instances (struct-identity duplication). See Investigation section. Pre-existing explicit-`: any` + `new C()` validation bug spun out as a separate finding."
priority: medium
feasibility: medium
reasoning_effort: high
goal: performance
sprint: Backlog
files:
  src/codegen/index.ts:
    new:
      - "interprocedural return type analysis"
  src/codegen/expressions.ts:
    breaking:
      - "use inferred return types at call sites"
---
# #685 — Interprocedural type flow: track return types across call sites

## Status: open

Currently each function's return type is resolved from TS declarations. But for untyped functions or functions returning union types, the actual runtime return type may be more specific.

### Approach
1. After compiling a function body, record its actual Wasm return type (not the TS-declared type)
2. At call sites, use the actual return type instead of the declared type
3. This avoids unnecessary boxing/unboxing when a function declared as `any` always returns f64

### Example
```typescript
function getValue() { return 42; }  // TS infers number, but declared return is any in some contexts
const x = getValue();  // Currently: externref. After fix: f64
```

### Implementation
Add `ctx.actualReturnTypes: Map<string, ValType>` populated during function body compilation. At call sites, check this map before falling back to TS type resolution.

## Complexity: M

---

## Investigation & Conclusion (sd-1665, sprint 58) — substantially done by existing infra; proposed extension is benefit-neutral + risk-bearing

**Recommendation: close as done-by-existing-infra (or rescope narrowly). No code change shipped.**

### What already exists (the issue's ask is largely implemented)
The "track return types across call sites" mechanism the issue proposes (a
`ctx.actualReturnTypes` map consulted at call sites) is **already present** in
two cooperating pieces:

1. `getWasmFuncReturnType(ctx, funcIdx)` in
   `src/codegen/expressions/helpers.ts:313` reads the callee's *actual* Wasm
   result type from `ctx.mod.functions[i].typeIdx` and is used pervasively at
   call sites with the pattern `getWasmFuncReturnType(...) ?? resolveWasmType(ctx, retType)`
   (≈15 sites in `src/codegen/expressions/calls.ts`, plus new-super.ts /
   calls-closures.ts). This is exactly "use the actual return type at call
   sites instead of the declared type."
2. `inferNumericReturnTypes` (#1121, `src/codegen/declarations.ts:1574`)
   promotes implicit-`any`-returning functions to `f64` when the body is a
   pure numeric kernel — covering the issue's own `getValue(){return 42}`
   example.
3. The function body's return coercion (`function-body.ts:598-616`) reads the
   *registered signature* result, so any signature-level promotion
   automatically flows to both the body and (via #1) the call sites. The
   `numericReturnTypes` map is just one *source* feeding this generic plumbing.

So TypeScript's own return inference + #1 + #2 already capture essentially all
the **safe** interprocedural return-type benefit.

### The residual gap and why extending it does not pay off
The only uncovered case is a function whose TS-declared return is **implicit
`any`/`unknown`** but whose body uniformly returns a concrete *reference* type
(class instance / array / etc.). I prototyped a reference-return analog of
`inferNumericReturnTypes` (`inferReferenceReturnType`, wired into both
function-registration paths in `declarations.ts`). Findings:

- **TS rarely yields implicit-any returns for concrete bodies.** For
  `function f(){ return new C(); }` and even recursive linked-list builders,
  the checker already resolves the return to `C` (not `any`), so the new pass
  never fires — the existing `resolveWasmType(retType)` path already emits
  `ref $C`. (Verified via `getReturnTypeOfSignature` flags.)
- **When the return IS implicit-any (e.g. explicit `: any` annotation),
  promoting the signature is benefit-neutral.** The call site stores the
  result into a TS-`any`-typed local (→ externref) and the existing coercion
  machinery re-boxes the concrete ref straight back to externref at the
  `local.set`. Measured: `sum(makeArr(5))` returns the correct `15` both with
  and without the promotion — identical Wasm behavior, no fewer box/unbox ops
  in the reachable path.
- **For class-instance returns the promotion is actively unsound.** At
  signature-registration time `structMap.get("C")` / `resolveWasmType(C)` can
  return a *different* (anonymous, minted) struct typeIdx than the canonical
  `$C` the constructor (`new C()`) uses; the minted index is dropped by the
  type-compaction pass, leaving the funcType at `externref` while the body
  emits `ref $C` → **Wasm validation failure** (`return[0] expected externref,
  got (ref null 5)`). I had to add an explicit `ctx.classSet` exclusion to keep
  the prototype sound, which removed the only class-shaped wins.

Net: the extension is **behavior-neutral but benefit-neutral** in every
reachable case, and risk-bearing for classes. Shipping it would add dead,
fragile code. Reverted.

### Separate pre-existing bug found (NOT #685 — needs its own issue)
`function f(): any { return new C(); }` (explicit `: any` return annotation +
`new` of a user class) **already fails Wasm validation on `main`**
(`type error in return[0] (expected externref, got (ref null 5))`), independent
of any #685 change. Root cause: the class instance's struct is registered
under two diverging typeIdx values (class collector vs `resolveWasmType`-minted
shape); the body uses the canonical `$C`, the externref-typed signature does
not, and compaction drops the minted one. The inferred-return form
(`function f(){ return new C(); }`) is fine. Minimal repro:
`class C { x:number; constructor(v:number){this.x=v;} } function make(v:number): any { return new C(v); }`.
Recommend a dedicated `fix(codegen): explicit any-return + new ClassInstance
struct-identity mismatch` issue (medium, touches struct registration /
compaction fixup).

### If #685 is ever rescoped to deliver real wins
It would require unifying class-struct identity (one canonical struct per
class, no minted duplicates) AND propagating the concrete return type into the
*call-site consumer's* local typing (not just the function signature) so the
value is not immediately re-boxed to externref. That is a substantially larger
codegen change than this issue's "M" estimate and should be re-triaged.
