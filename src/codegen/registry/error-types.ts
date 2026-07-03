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
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js"; // (#1916 S3b) stable-regime minting
import type { Instr, ValType } from "../../ir/types.js";

import { BUILTIN_TYPE_TAGS } from "../builtin-tags.js";
import { addFuncType, getOrRegisterErrorStructType } from "./types.js";
import { addStringConstantGlobal } from "./imports.js";
import { stringConstantExternrefInstrs, ensureAnyToStringHelper } from "../native-strings.js";
import { emitNativeNumberFormat } from "../number-format-native.js";

// (#2962) `getOrRegisterErrorStructType` moved to registry/types.ts so
// native-strings.ts can import it without an import cycle (this module imports
// `stringConstantExternrefInstrs` FROM native-strings.ts). Re-exported here so
// the existing importers (class-bodies, property-access, assignment,
// identifiers) keep their import path.
export { getOrRegisterErrorStructType } from "./types.js";

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

  // (#2969) §20.5.1.1 step 3 — when a `message` argument is supplied and is not
  // undefined, the spec sets `msg = ToString(message)` at CONSTRUCTION time and
  // stores that string. Previously the raw first argument was stored verbatim,
  // so `new Error(42).message` was the number `42` (spec: `"42"`) and
  // `String(new Error(42))` degraded to `"Error"` (the §20.5.3.4 renderer treats
  // a non-string message as absent). Route the argument through the standalone
  // `__any_to_string` chain (the in-module `String(x)` implementation, which
  // performs ToPrimitive/toString for objects and decimal formatting for
  // numbers) before `struct.new`, guarding the undefined/null-arg case so
  // argument-less / `new Error(undefined)` errors still render the name alone.
  //
  // Emission-order discipline (#329/#1448): `emitNativeNumberFormat` and
  // `ensureAnyToStringHelper` append functions (and may drive an
  // `addUnionImports` funcIdx shift), so they MUST run BEFORE this ctor reserves
  // its own `funcIdx` below — otherwise the reserved index goes stale. Forcing
  // `number_toString` first keeps `__any_to_string`'s number arm real (else a
  // module that only constructs an error never pulls it in and the arm degrades
  // to "[object Object]"). Gated on standalone/native-strings; host mode uses
  // real JS Error objects (no struct ctor) and stays byte-identical.
  let messageFieldInstrs: Instr[];
  if (argCount > 0 && (ctx.standalone || ctx.nativeStrings)) {
    if (ctx.funcMap.get("number_toString") === undefined) {
      emitNativeNumberFormat(ctx, new Set(["number_toString"]));
    }
    const anyToStrIdx = ensureAnyToStringHelper(ctx);
    messageFieldInstrs = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        // undefined / null argument → no message property (renders name alone).
        then: [{ op: "ref.null.extern" }],
        // ToString(message): externref → anyref → `__any_to_string` (ref
        // $AnyString) → externref for the $message field.
        else: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" } as Instr,
          { op: "call", funcIdx: anyToStrIdx },
          { op: "extern.convert_any" } as Instr,
        ],
      } as Instr,
    ];
  } else if (argCount > 0) {
    messageFieldInstrs = [{ op: "local.get", index: 0 }];
  } else {
    messageFieldInstrs = [{ op: "ref.null.extern" }];
  }

  const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" }) as ValType);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `${importName}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(importName, funcIdx);

  // Body: push fields in struct field order (tag, message, name), then
  // `struct.new $Error_struct`, then `extern.convert_any` so the result has
  // the externref ABI shape that the `__new_<Name>` callers expect.
  const body: Instr[] = [
    { op: "i32.const", value: tagValue },
    // $message — (#2969) ToString(arg0) at construction (§20.5.1.1), or null
    // when the ctor takes no argument / the argument is undefined.
    ...messageFieldInstrs,
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

  pushDefinedFunc(ctx, funcIdx, {
    name: importName,
    typeIdx,
    locals: [],
    body,
    exported: false,
  });
}
