// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 C5) An INHERITED builtin method on a standalone `class X extends
 * <Number|Boolean|String>` receiver dispatches as it would on the parent.
 *
 * ## The gap (measured 2026-09-29, `--target standalone`)
 *
 * | source                                         | node      | before              |
 * | ---------------------------------------------- | --------- | ------------------- |
 * | `class N extends Number {}; new N(42).toFixed(2)` | `"42.00"` | TypeError: called value is not a function |
 * | `class S extends String {}; new S(" a ").trim()`  | `"a"`     | TypeError: called value is not a function |
 * | `class B extends Boolean {}; new B(1).valueOf()`  | `true`    | `false`             |
 *
 * The carrier is right — the #3972 wrapper rung builds a real `$Object`
 * wrapper box, the same one `new Number(42)` builds, and C5 makes it honour its
 * argument. What misses is the DISPATCH. Every native Number/String/Boolean
 * method lowering is gated on the receiver's STATIC type naming the wrapper
 * (`isNumberWrapperType` / `isStringWrapperType` / `isBooleanWrapperType` — a
 * symbol-name test), and a subclass-typed receiver names `N`, not `Number`. So
 * the call fell to the dynamic `__extern_method_call` terminal, whose `$Object`
 * arm resolves the name through the open property bag — where no builtin
 * prototype method lives — and threw; `valueOf` took the ordinary-class
 * identity fold and answered the object itself.
 *
 * ## The fix
 *
 * When the member the checker resolves is the PARENT's own lib declaration
 * (`interface Number { toFixed(…) }` in a `.d.ts`), the call site is compiled
 * against the parent's instance type instead. That is exactly the question the
 * spec asks: the method found on the prototype chain IS `%Number.prototype%`'s,
 * and it runs with `this` = the instance, whose [[NumberData]] the wrapper box
 * carries. A user override (declared anywhere in the class chain) resolves to a
 * non-lib declaration and is declined, as is every `Object.prototype` member
 * (declared on `interface Object`, not on the parent).
 *
 * ## Scope
 *
 * Standalone/WASI only (the JS-host lane constructs a real host object with the
 * real prototype and never reaches here), direct method calls only, and only the
 * three parents whose standalone carrier is the parent's own native value.
 */
import type { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** Parents whose standalone subclass carrier IS the parent's native value. */
const ROUTED_BUILTIN_PARENTS: ReadonlySet<string> = new Set(["Number", "Boolean", "String"]);

/** The parent's lib instance type among `type`'s (transitive) base types. */
function builtinBaseType(type: ts.Type, parent: string, depth = 0): ts.Type | undefined {
  if (depth > 8) return undefined;
  for (const base of type.getBaseTypes?.() ?? []) {
    if (base.getSymbol()?.name === parent) return base;
    const deeper = builtinBaseType(base, parent, depth + 1);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/**
 * Type-only half: the routed parent's lib instance type when `receiverType` is
 * a (user) class type deriving from it and `method` resolves to that parent's
 * OWN lib declaration. Shared by the import collector, which runs before the
 * class maps below exist.
 */
function inheritedBuiltinMemberBase(receiverType: ts.Type, method: string): ts.Type | undefined {
  const symbolName = receiverType.getSymbol()?.name;
  if (symbolName === undefined || ROUTED_BUILTIN_PARENTS.has(symbolName)) return undefined;
  const declarations = receiverType.getProperty(method)?.getDeclarations() ?? [];
  if (declarations.length === 0) return undefined;
  let parent: string | undefined;
  for (const declaration of declarations) {
    const owner = (declaration.parent as (ts.Node & { name?: { text?: string } }) | undefined)?.name?.text;
    if (!declaration.getSourceFile().isDeclarationFile || owner === undefined) return undefined;
    if (!ROUTED_BUILTIN_PARENTS.has(owner) || (parent !== undefined && parent !== owner)) return undefined;
    parent = owner;
  }
  return parent === undefined ? undefined : builtinBaseType(receiverType, parent);
}

/**
 * The import collector's receiver type: an inherited member of a
 * Number/Boolean/String subclass needs the same native helpers as the parent
 * (`number_toFixed`, …), which the collector registers by receiver type.
 */
export function collectorReceiverType(ctx: CodegenContext, receiverType: ts.Type, method: string): ts.Type {
  if (!(ctx.standalone || ctx.wasi)) return receiverType;
  return inheritedBuiltinMemberBase(receiverType, method) ?? receiverType;
}

/**
 * The parent builtin's instance type when `receiverType` is a standalone
 * externref-backed subclass of a routed parent and `method` resolves to that
 * parent's own lib declaration; `undefined` (keep the receiver type) otherwise.
 */
export function inheritedBuiltinReceiverType(
  ctx: CodegenContext,
  receiverType: ts.Type,
  method: string,
): ts.Type | undefined {
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  const symbolName = receiverType.getSymbol()?.name;
  if (symbolName === undefined) return undefined;
  const className = ctx.classExprNameMap.get(symbolName) ?? symbolName;
  if (!ctx.classExternrefBackedSet.has(className)) return undefined;
  const base = inheritedBuiltinMemberBase(receiverType, method);
  return base !== undefined && base.getSymbol()?.name === ctx.classBuiltinParentMap.get(className) ? base : undefined;
}
