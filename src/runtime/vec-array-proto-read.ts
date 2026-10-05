// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4526) Inherited `Array.prototype` members of a compiled array read through
// the host boundary.
//
// A compiled array is an opaque WasmGC vec struct. A dynamic member read —
// `actual.includes` where `actual` is an `any`/externref slot — reaches
// `__extern_get`, which answers own data (`length`, indices, sidecar
// properties) but had no answer for the members an Array INHERITS. So
// `typeof actual.includes` was "undefined", and the upstream harness's
// `toContain` (`typeof actual.includes !== "function" || …`) failed every
// assertion on a compiled array (Redux "exposes the public API").
//
// §10.1.8.1 OrdinaryGet: a member the array does not own is read from its
// [[Prototype]], %Array.prototype%. So the answer is the realm intrinsic
// itself — `arr.includes === Array.prototype.includes` holds, and invoking it
// with the vec as receiver goes through the existing host-call bridges (which
// mirror the vec and write mutations back, see vec-mirror-writeback.ts).
//
// Scope: string keys only, only after every own/sidecar read has missed, and
// never for a registered `arguments` object (its [[Prototype]] is
// %Object.prototype%, not %Array.prototype%). `length` is an OWN property of
// an array and is never answered from the prototype.

// Captured at module load: test262 bodies may delete or replace these.
const _arrayProto = Array.prototype;
const _hasOwn = Object.prototype.hasOwnProperty;
const _getPrototypeOf = Object.getPrototypeOf;

function inheritedByArray(key: string): boolean {
  for (let proto: object | null = _arrayProto; proto !== null; proto = _getPrototypeOf(proto)) {
    if (_hasOwn.call(proto, key)) return true;
  }
  return false;
}

/**
 * The inherited `Array.prototype` member `key` of a compiled vec `obj`, or
 * `undefined` when `obj` is not a compiled array or `key` is not inherited.
 */
export function vecInheritedArrayMember(
  obj: unknown,
  key: unknown,
  exports: Record<string, Function> | undefined,
  isArgumentsObject: (value: object) => boolean,
): unknown {
  if (typeof key !== "string" || key === "length" || key === "__proto__") return undefined;
  if (obj === null || typeof obj !== "object" || isArgumentsObject(obj)) return undefined;
  const isVec = exports?.__is_vec as ((value: unknown) => number) | undefined;
  if (typeof isVec !== "function") return undefined;
  try {
    if (isVec(obj) !== 1) return undefined;
  } catch {
    return undefined;
  }
  if (!inheritedByArray(key)) return undefined;
  return (_arrayProto as unknown as Record<string, unknown>)[key];
}
