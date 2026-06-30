// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Wasm-native Error construction for standalone / WASI mode (#1104 Phase 1).
 *
 * In JS-host mode, `new Error("msg")` lowers to a `__new_Error` host import
 * that resolves to the JS `Error` constructor. In standalone mode (`--target
 * wasi`) there is no JS host, so the import is unsatisfied and the wasm
 * module fails to instantiate with `Import #N "env": module is not an object
 * or function`.
 *
 * Phase 1 scope (this module): replace the `__new_<ErrorName>` host imports
 * with internal Wasm functions that build a WasmGC `$Error_struct` and return
 * it as externref. This unblocks instantiation and lets `throw new Error(...)`
 * (which already coerces the value to externref via the existing exception
 * tag) work in standalone mode.
 *
 * **Out of scope for Phase 1** (deferred to follow-up phases):
 *   - Property access for `err.message` / `err.name` — still routes through
 *     the JS-host `__extern_get` import.
 *   - `error instanceof TypeError` — still routes through the JS-host
 *     `__instanceof` import. The `$tag` field on `$Error_struct` is populated
 *     here so a future Phase 3 can drive ref.test/struct.get-based instanceof.
 *   - Stack traces — `error.stack` returns undefined (option 1 from the issue).
 *
 * The struct shape is intentionally minimal:
 *
 * ```
 * (type $Error_struct (struct
 *   (field $tag       i32)               ;; from BUILTIN_TYPE_TAGS
 *   (field $message   (mut externref))   ;; the constructor argument
 *   (field $name      externref)         ;; "Error" / "TypeError" / etc.
 * ))
 * ```
 *
 * The `$message` field is mutable because spec §20.5.1.1 allows
 * `error.message = "x"` writes. `$name` and `$tag` are immutable — the spec
 * does allow `error.name = "x"` overrides on subclasses, but Phase 2 will
 * decide whether to mirror that into the struct field or via a sidecar map.
 *
 * Issue: plan/issues/backlog/1104-wasm-native-error-construction-and.md
 * Related: src/codegen/builtin-tags.ts (#1325 type-tag registry)
 */

import type { CodegenContext } from "../context/types.js";
import type { Instr, ValType } from "../../ir/types.js";

import { BUILTIN_TYPE_TAGS } from "../builtin-tags.js";
import { addFuncType } from "./types.js";
import { addStringConstantGlobal } from "./imports.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";

/**
 * The 8 built-in JS Error constructors that Phase 1 supports as Wasm-native
 * struct construction in WASI mode. Order matches the order in which test262
 * tests typically reference them.
 */
const WASI_ERROR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "AggregateError",
] as const;

export type WasiErrorName = (typeof WASI_ERROR_NAMES)[number];

/** Returns true if `name` is one of the 8 Error constructors handled by Phase 1. */
export function isWasiErrorName(name: string): name is WasiErrorName {
  return (WASI_ERROR_NAMES as readonly string[]).includes(name);
}

/**
 * Get or register the `$Error_struct` WasmGC type. Idempotent — returns the
 * cached type index on subsequent calls.
 */
export function getOrRegisterErrorStructType(ctx: CodegenContext): number {
  if (ctx.errorStructTypeIdx >= 0) return ctx.errorStructTypeIdx;

  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$Error_struct",
    fields: [
      { name: "tag", type: { kind: "i32" }, mutable: false },
      { name: "message", type: { kind: "externref" }, mutable: true },
      { name: "name", type: { kind: "externref" }, mutable: false },
      // (#1536) $stack — fieldIdx 3, kept AFTER message(1)/name(2) so their
      // indices stay stable. `error.stack` is non-standard (no normative
      // test262 coverage); materializing a real stack trace needs no Wasm
      // primitive, so standalone constructs it as `ref.null.extern` (reads
      // back as `undefined`, not a trap). Mutable so a future `err.stack = …`
      // write can land here without a struct-type change.
      { name: "stack", type: { kind: "externref" }, mutable: true },
      // (#2188) $userClassId — fieldIdx 4. Per-user-Error-subclass brand that
      // distinguishes sibling `extends Error` classes which all share the SAME
      // builtin parent `$tag` (field 0). `__new_<Parent>` writes the sentinel
      // `-1` (a plain builtin Error / the shared parent ctor has no user-class
      // brand); the subclass `super()` site overwrites it with the subclass's
      // `classTagMap` id (see emitSetSubclassUserBrand in class-bodies.ts). The
      // standalone `instanceof <UserSubclass>` path reads this field instead of
      // the shared builtin tag, so `(new A) instanceof B` is false for distinct
      // siblings A,B. Mutable: the brand is written AFTER struct.new at the
      // per-subclass construction site, not baked into the shared parent ctor.
      // Kept LAST so fields 0..3 stay stable.
      { name: "userClassId", type: { kind: "i32" }, mutable: true },
      // (#2101a R5) $props — fieldIdx 5. Backing store for user-declared OWN
      // fields on an externref-backed Error subclass (`class A extends Error {
      // code = 0 }`). Such an instance IS this `$Error_struct` (no per-subclass
      // WasmGC struct), so own fields have nowhere to live — `this.code = …`
      // previously cast `this` to the vestigial `$A` struct and trapped. Holds
      // an externref to an open `$Object` (the LANDED object-runtime), lazily
      // allocated via `__new_plain_object()` on the first own-field write;
      // reads/writes route through `__extern_get`/`__extern_set`. `ref.null`
      // until first written. Stored as externref (not `ref null $Object`) to
      // avoid a forward type-reference to `$Object` here — `$Object` is
      // registered lazily by the object-runtime, which may run AFTER this
      // struct. Kept LAST so fields 0..4 stay stable.
      { name: "props", type: { kind: "externref" }, mutable: true },
    ],
  });
  ctx.errorStructTypeIdx = idx;
  return idx;
}

/**
 * Emit an internal Wasm function `__new_<errorName>` that constructs a new
 * `$Error_struct` and returns it as externref. The function takes `argCount`
 * externref params (the constructor arguments seen at call sites — typically
 * 0 or 1 for `new Error(msg)`).
 *
 * Idempotent — does nothing if `__new_<errorName>` is already registered
 * (whether as a host import or a previously-emitted internal function).
 *
 * #1536 Phase 2 — the `$name` field is now materialized with the error
 * class's name string ("Error" / "TypeError" / …) instead of the Phase-1
 * `ref.null extern` placeholder, so `err.name` reads the correct value in
 * standalone mode (the property-access fast path in `property-access.ts`
 * already does `struct.get $Error_struct[2]` for `.name` under
 * `ctx.wasi || ctx.standalone`). The constant is materialized via the
 * shared `stringConstantExternrefInstrs` dual-mode helper: nativeStrings
 * mode builds the FlatString struct inline + `extern.convert_any`;
 * host-strings mode emits a `global.get` of the interned string constant.
 * The string is registered via `addStringConstantGlobal` first so the
 * helper finds it in `ctx.stringGlobalMap`.
 */
export function emitWasiErrorConstructor(ctx: CodegenContext, errorName: WasiErrorName, argCount: number): void {
  emitErrorStructConstructor(ctx, `__new_${errorName}`, errorName, BUILTIN_TYPE_TAGS[errorName], argCount);
}

/**
 * (#2902) Standalone/WASI-native `new Test262Error(msg)` construction.
 *
 * The test262 harness injects `class Test262Error { message }` (and, in the
 * JS-host eval shim, `class Test262Error extends Error`) into every wrapped
 * test. In JS-host mode `new Test262Error(msg)` lowers to a `__new_Test262Error`
 * host import that yields a real `Error` subclass. In standalone mode there is
 * no JS host, so that import is unsatisfiable and leaks into the module — even
 * though the constructor is only ever reached on the (untaken) failure path of
 * a passing test. A leak-analysis of the merge_group standalone report found
 * ~2,779 tests that import ONLY `env::__new_Test262Error`, so building it
 * in-module flips them host-free.
 *
 * The value is built as the SAME `$Error_struct` the WASI error constructors
 * use, tagged as `Error` (so `instanceof Error` holds, matching
 * `Test262Error extends Error`) with `$name` = "Test262Error" (so `err.name`
 * and the standalone exception formatter read the correct constructor name).
 * `err.message` reads the first-arg field via the existing property-access
 * fast path. Host mode is unchanged — it keeps the `__new_Test262Error` import.
 */
export function emitStandaloneTest262Error(ctx: CodegenContext, argCount: number): void {
  emitErrorStructConstructor(ctx, "__new_Test262Error", "Test262Error", BUILTIN_TYPE_TAGS.Error, argCount);
}

/**
 * Shared builder for an in-module `$Error_struct` constructor. `displayName` is
 * materialized into the `$name` field; `tagValue` is written to `$tag` (drives
 * standalone `instanceof`). Idempotent on `importName`.
 */
function emitErrorStructConstructor(
  ctx: CodegenContext,
  importName: string,
  displayName: string,
  tagValue: number,
  argCount: number,
): void {
  if (ctx.funcMap.has(importName)) return;

  const structIdx = getOrRegisterErrorStructType(ctx);

  // #1536 Phase 2 — register the class-name string so the $name field can be
  // materialized below. Must run BEFORE building the body so the dual-mode
  // helper finds the interned global.
  addStringConstantGlobal(ctx, displayName);
  const nameInstrs = stringConstantExternrefInstrs(ctx, displayName);

  const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" }) as ValType);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `${importName}_type`);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(importName, funcIdx);

  // Body: push fields in struct field order (tag, message, name), then
  // `struct.new $Error_struct`, then `extern.convert_any` so the result has
  // the externref ABI shape that the `__new_<Name>` callers expect.
  const body: Instr[] = [
    { op: "i32.const", value: tagValue },
    // $message — first arg if present, else null
    argCount > 0 ? { op: "local.get", index: 0 } : { op: "ref.null.extern" },
    // $name — #1536 Phase 2: materialized class-name string ("TypeError" …)
    // as externref, replacing the Phase-1 `ref.null.extern` placeholder.
    ...nameInstrs,
    // $stack — (#1536) non-standard; standalone has no stack-capture
    // primitive, so initialize to null (reads back as `undefined`).
    { op: "ref.null.extern" },
    // $userClassId — (#2188) -1 sentinel: a plain builtin Error (or the shared
    // parent ctor of a user subclass) carries no per-user-class brand. The
    // subclass `super()` site overwrites this field after construction.
    { op: "i32.const", value: -1 },
    // $props — (#2101a R5) own-field backing store; null until the subclass's
    // first own-field write lazily allocates an `$Object` here.
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: structIdx },
    { op: "extern.convert_any" },
  ];

  ctx.mod.functions.push({
    name: importName,
    typeIdx,
    locals: [],
    body,
    exported: false,
  });
}
