// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Registry of host-resolvable builtin global class/object names, extracted
// from calls.ts (#1793; LOC-regrowth ratchet #3102 — grow the registry in
// this leaf module, not the god-file). calls.ts re-exports it, so existing
// importers (call-builtin-static.ts, call-receiver-method.ts) are unaffected.

/**
 * Known built-in global class/object names that compile to ref.null.extern
 * via compileIdentifier's graceful fallback. These need __get_builtin to
 * resolve the real JS object for host-delegated calls (method dispatch,
 * getOwnPropertyDescriptor, etc.).
 */
export const BUILTIN_CLASS_NAMES = new Set([
  "Object",
  "Array",
  "Function",
  "Symbol",
  "Proxy",
  "Reflect",
  "Math",
  "BigInt",
  "JSON",
  "Date",
  "RegExp",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Promise",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Atomics",
  "Iterator",
  "Map",
  "Set",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "String",
  "Number",
  "Boolean",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  // (#1793) Node's global Buffer — host class (JS-host lane only; the
  // `__get_builtin` resolver reads `globalThis.Buffer`). Statics
  // (from/alloc/concat/...) dispatch via __extern_method_call like any
  // other builtin; instances are plain externrefs.
  "Buffer",
]);
