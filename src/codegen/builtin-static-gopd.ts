// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2984 Phase 3) Standalone `Object.getOwnPropertyDescriptor(<Ctor|Namespace>,
 * "<member>")` — static-property descriptor synthesis for builtin CONSTRUCTOR /
 * namespace receivers (`gOPD(Math, "atan2")`, `gOPD(Date, "prototype")`,
 * `gOPD(Number, "MAX_VALUE")`, `gOPD(String, "length")`).
 *
 * ## Why a compile-time synthesis site
 *
 * Under `--target standalone` a builtin identifier used as a *dynamic* gOPD
 * receiver routes through the `__get_builtin` shortcut (calls.ts), which
 * refuses-loud (#1472 Phase B) — the whole shape is a hard CE (~72 test262
 * files across the gOPD dirs, measured 2026-07-10). But every OWN property of
 * a standard builtin ctor/namespace is statically known, so the descriptor can
 * be synthesized at compile time from the same tables the direct-read arms
 * already use — the ctor/namespace sibling of the #2885 Site-2 proto-receiver
 * synthesis (which fable-2984b's Phase 2 completed for `<Builtin>.prototype`
 * receivers).
 *
 * ## Classification (§ references = ECMA-262)
 *
 * - `"prototype"` on a builtin FUNCTION (`BUILTIN_CTOR_ARITY` membership;
 *   excludes the Math/JSON/Reflect/Atomics namespaces and §28.2 `Proxy`, which
 *   own no `prototype`): data descriptor `{w:false, e:false, c:false}`; the
 *   value is the `$NativeProto` object when the builtin has registered glue
 *   (`emitLazyNativeProtoGet` — same identity as a plain `<Ctor>.prototype`
 *   read), else `undefined` (attributes still spec-correct — the dominant
 *   15.2.3.3-4-18x/2xx shape asserts attributes + get/set absence only).
 * - `"length"` / `"name"` on a builtin function: `{w:false, e:false, c:true}`
 *   (§10.2.9 / §20.x), value from `BUILTIN_CTOR_ARITY` / the ctor name.
 * - Math/Number numeric constants (`MATH_CONSTANT_VALUES` /
 *   `NUMBER_CONSTANT_VALUES`) and `<TypedArray>.BYTES_PER_ELEMENT`
 *   (§21.3.x/§21.1.2.x/§23.2.6.1): `{w:false, e:false, c:false}` value
 *   descriptors.
 * - Static METHODS (`BUILTIN_STATIC_METHOD_ARITY` membership): `{w:true,
 *   e:false, c:true}` with `.value` = the per-(builtin, method) SINGLETON
 *   closure — the SAME value a plain `Math.atan2` read materializes
 *   (property-access.ts), so `gOPD(Math, "atan2").value === Math.atan2`
 *   holds (the dominant 15.2.3.3-4-9x/1xx assertion).
 * - Any OTHER string key on a CLOSED-universe receiver: the arms above cover
 *   the complete standard own STRING-keyed surface, so the member is
 *   genuinely absent → `undefined` (`gOPD(Math, "caller")`,
 *   `gOPD(Function, "arguments_1")`). Symbol (well-known-symbol props read as
 *   strings elsewhere: `Symbol.iterator` is an OWN data property this table
 *   set does not model) and RegExp (annex-B legacy statics `$1`…`$9`,
 *   `input`, `lastMatch`, …) have OPEN universes — unknown members there fall
 *   through to the caller (the existing refusal), never a phantom
 *   `undefined`.
 *
 * ## Safety envelope
 *
 * The caller gates on `ctx.standalone` + unshadowed builtin identifier +
 * literal key — every intercepted shape CE'd on main (`__get_builtin`
 * refusal), so nothing currently passing can change. Host/gc/wasi lanes never
 * reach this module. Each arm resolves its natives (`ensureLateImport` +
 * flush) BEFORE pushing operands, so a `false` return never leaves partial
 * instructions in `fctx.body`.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { BUILTIN_STATIC_METHOD_ARITY, pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { emitLazyNativeProtoGet } from "./native-proto.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import {
  BUILTIN_CTOR_ARITY,
  ensureStandaloneBuiltinStaticMethodClosure,
  MATH_CONSTANT_VALUES,
  NUMBER_CONSTANT_VALUES,
  TYPED_ARRAY_BYTES_PER_ELEMENT,
  tryEnsureNativeProtoBrand,
} from "./property-access.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

// §6.1.7.3 attribute flag bits — mirrors object-runtime's `__create_descriptor`
// (1=writable, 2=enumerable, 4=configurable).
const FLAG_WRITABLE = 0x01;
const FLAG_CONFIGURABLE = 0x04;

function resolveCreateDescriptor(ctx: CodegenContext, fctx: FunctionContext): number | undefined {
  const idx = ensureLateImport(
    ctx,
    "__create_descriptor",
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  return idx;
}

function resolveBoxNumber(ctx: CodegenContext, fctx: FunctionContext): number | undefined {
  const idx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  return idx;
}

/** Emit `__create_descriptor(box(value), flags)` for a numeric constant. */
function emitNumericValueDescriptor(ctx: CodegenContext, fctx: FunctionContext, value: number, flags: number): boolean {
  const boxIdx = resolveBoxNumber(ctx, fctx);
  const createIdx = resolveCreateDescriptor(ctx, fctx);
  if (boxIdx === undefined || createIdx === undefined) return false;
  fctx.body.push({ op: "f64.const", value } as Instr);
  fctx.body.push({ op: "call", funcIdx: boxIdx } as Instr);
  fctx.body.push({ op: "i32.const", value: flags } as Instr);
  fctx.body.push({ op: "call", funcIdx: createIdx } as Instr);
  return true;
}

/**
 * Synthesize the descriptor for `Object.getOwnPropertyDescriptor(<builtin>,
 * "<member>")` with a builtin ctor/namespace IDENTIFIER receiver. Leaves one
 * externref (the descriptor `$Object`, or null-extern = `undefined` for a
 * genuinely absent member) on the stack and returns `true`; returns `false`
 * — with NOTHING pushed — when the member cannot be answered statically
 * (caller falls through to the existing `__get_builtin` refusal).
 */
export function tryEmitStandaloneBuiltinStaticGopd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
  member: string,
): boolean {
  const isCtorFunction = builtinName in BUILTIN_CTOR_ARITY;

  // ── "prototype" — own of every builtin function except Proxy (§28.2) ──────
  if (member === "prototype") {
    if (isCtorFunction && builtinName !== "Proxy") {
      // Brand glue registration BEFORE the native resolve (Site-2 ordering).
      const brand = tryEnsureNativeProtoBrand(ctx, builtinName);
      const createIdx = resolveCreateDescriptor(ctx, fctx);
      if (createIdx === undefined) return false;
      if (brand === undefined || !emitLazyNativeProtoGet(ctx, fctx, brand)) {
        // No reified proto object for this builtin yet — the attribute
        // assertions (the only shape in the corpus) still pass.
        fctx.body.push({ op: "ref.null.extern" } as Instr);
      }
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      fctx.body.push({ op: "call", funcIdx: createIdx } as Instr);
      return true;
    }
    // Namespaces (Math/JSON/Reflect/Atomics) and Proxy own no "prototype".
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return true;
  }

  // ── "length" / "name" on a builtin function — {w:false, e:false, c:true} ──
  if ((member === "length" || member === "name") && isCtorFunction) {
    if (member === "length") {
      return emitNumericValueDescriptor(ctx, fctx, BUILTIN_CTOR_ARITY[builtinName]!, FLAG_CONFIGURABLE);
    }
    const createIdx = resolveCreateDescriptor(ctx, fctx);
    if (createIdx === undefined) return false;
    addStringConstantGlobal(ctx, builtinName);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, builtinName));
    fctx.body.push({ op: "i32.const", value: FLAG_CONFIGURABLE } as Instr);
    fctx.body.push({ op: "call", funcIdx: createIdx } as Instr);
    return true;
  }

  // ── Math/Number numeric constants — {w:false, e:false, c:false} ───────────
  const constTable =
    builtinName === "Math" ? MATH_CONSTANT_VALUES : builtinName === "Number" ? NUMBER_CONSTANT_VALUES : undefined;
  if (constTable && Object.prototype.hasOwnProperty.call(constTable, member)) {
    return emitNumericValueDescriptor(ctx, fctx, constTable[member]!, 0);
  }

  // ── <TypedArray>.BYTES_PER_ELEMENT — {w:false, e:false, c:false} ──────────
  if (member === "BYTES_PER_ELEMENT" && builtinName in TYPED_ARRAY_BYTES_PER_ELEMENT) {
    return emitNumericValueDescriptor(ctx, fctx, TYPED_ARRAY_BYTES_PER_ELEMENT[builtinName]!, 0);
  }

  // ── Static METHOD — {w:true, e:false, c:true}, identity-stable value ──────
  if (BUILTIN_STATIC_METHOD_ARITY[builtinName]?.[member] !== undefined) {
    const closure = ensureStandaloneBuiltinStaticMethodClosure(ctx, builtinName, member);
    if (!closure) return false;
    const createIdx = resolveCreateDescriptor(ctx, fctx);
    if (createIdx === undefined) return false;
    // (#2175 V2-S2) The per-(builtin, method) singleton — the SAME value a
    // plain `<Builtin>.<method>` read yields, so `desc.value === Math.atan2`.
    fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
    fctx.body.push({ op: "extern.convert_any" } as Instr);
    fctx.body.push({ op: "i32.const", value: FLAG_WRITABLE | FLAG_CONFIGURABLE } as Instr);
    fctx.body.push({ op: "call", funcIdx: createIdx } as Instr);
    return true;
  }

  // ── Unknown member ─────────────────────────────────────────────────────────
  // Symbol (own well-known-symbol data props: `Symbol.iterator`, …) and RegExp
  // (annex-B legacy statics: `$1`…`$9`, `input`, …) have OPEN own-property
  // universes the tables above do not close — refuse rather than fabricate a
  // phantom `undefined`. Every other receiver's standard own STRING-keyed
  // surface is fully covered above, so the member is genuinely absent.
  if (builtinName === "Symbol" || builtinName === "RegExp") return false;
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  return true;
}
