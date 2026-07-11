// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3141 — self-hosted stdlib driver (pilot: Math helpers).
 *
 * Compiles a builtin written as ORDINARY TypeScript source (see
 * `src/stdlib/math.ts`) through the compiler's OWN pipeline —
 * `lowerFunctionAstToIr` (front-end) → IR hygiene passes →
 * `lowerIrFunctionToWasm` (BackendEmitter) — and registers the result as
 * a defined function, exactly where the hand-emitted `Instr[]` bodies
 * used to be pushed. This is the porffor model: builtins are source the
 * compiler precompiles, not hand-assembly.
 *
 * Two-stage split (why it's cheap):
 *   1. `buildBuiltinIr` — parse + from-ast + verify + passes. The
 *      resulting `IrFunction` is CONTEXT-INDEPENDENT (all cross-function
 *      references are symbolic `IrFuncRef`s by name — spec #1131 §1.2),
 *      so it is memoized once per process and shared across compilations.
 *      The IR is never mutated after the pass pipeline (lowering only
 *      reads it), which is what makes the memoization sound.
 *   2. `emitSelfHostedMathFunc` — per compilation, lower the memoized IR
 *      against the LIVE CodegenContext. Symbol resolution happens here:
 *      `IrFuncRef("Math_exp")` → `ctx.funcMap` (the sibling helper
 *      registered moments earlier by `emitInlineMathFunctions`), and the
 *      function's own type is interned through the shared `addFuncType`
 *      registry. The produced body is plain `Instr[]` with absolute call
 *      indices — the same shape the hand-written bodies had, so every
 *      downstream pass (late-import index fixups, DCE, binary emit)
 *      treats it identically.
 *
 * Scope guard: the pilot's builtins are pure-f64 leaf math. Their IR
 * must never reference globals, named types, strings, objects, closures,
 * or vecs — the resolver below throws on all of those, which turns any
 * accidental dialect growth in `src/stdlib/math.ts` into a loud compile
 * error instead of a miscompile.
 */

import { ts } from "../ts-api.js";
import { lowerFunctionAstToIr } from "../ir/from-ast.js";
import { irVal, type IrFunction, type IrType } from "../ir/nodes.js";
import { constantFold } from "../ir/passes/constant-fold.js";
import { deadCode } from "../ir/passes/dead-code.js";
import { simplifyCFG } from "../ir/passes/simplify-cfg.js";
import { verifyIrFunction } from "../ir/verify.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../ir/lower.js";
import type { StdlibMathBuiltin } from "../stdlib/math.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";

const F64: IrType = irVal({ kind: "f64" });

/** Process-lifetime cache: builtin name → immutable, context-free IR. */
const irCache = new Map<string, IrFunction>();

/**
 * Parse the builtin's TS source and lower it to a verified, optimized
 * `IrFunction`. Pure function of the builtin definition — memoized.
 */
function buildBuiltinIr(builtin: StdlibMathBuiltin): IrFunction {
  const cached = irCache.get(builtin.name);
  if (cached) return cached;

  const sourceFile = ts.createSourceFile(
    `stdlib/${builtin.name}.ts`,
    builtin.source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const fnDecl = sourceFile.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === builtin.name,
  );
  if (!fnDecl) {
    throw new Error(`stdlib-selfhost: source for ${builtin.name} has no matching function declaration`);
  }

  // Sibling math helpers are all unary (f64) -> f64.
  const calleeTypes = new Map<string, { params: readonly IrType[]; returnType: IrType | null }>();
  for (const callee of builtin.callees) {
    calleeTypes.set(callee, { params: [F64], returnType: F64 });
  }

  const { main, lifted } = lowerFunctionAstToIr(fnDecl, {
    funcName: builtin.name,
    exported: false,
    calleeTypes,
  });
  if (lifted.length > 0) {
    throw new Error(`stdlib-selfhost: ${builtin.name} unexpectedly produced ${lifted.length} lifted functions`);
  }

  const buildErrors = verifyIrFunction(main);
  if (buildErrors.length > 0) {
    throw new Error(`stdlib-selfhost: IR verify failed for ${builtin.name}: ${buildErrors[0]!.message}`);
  }

  // Same hygiene pipeline integration.ts runs (constantFold → deadCode →
  // simplifyCFG to fixpoint; each pass returns the same reference when it
  // makes no change).
  let ir = main;
  for (let iter = 0; iter < 10; iter++) {
    const next = simplifyCFG(deadCode(constantFold(ir)));
    if (next === ir) break;
    ir = next;
  }

  const postErrors = verifyIrFunction(ir);
  if (postErrors.length > 0) {
    throw new Error(`stdlib-selfhost: post-pass IR verify failed for ${builtin.name}: ${postErrors[0]!.message}`);
  }

  irCache.set(builtin.name, ir);
  return ir;
}

/**
 * Lower a self-hosted math builtin against the live context and register
 * it as a defined function under `builtin.name`. Mirrors the hand path's
 * `addMathFunc` registration discipline (stable-regime mint + push,
 * funcMap entry) so call sites cannot tell the difference.
 *
 * Precondition: every name in `builtin.callees` is already registered in
 * `ctx.funcMap` (emitInlineMathFunctions emits Phase-1 cores first).
 */
export function emitSelfHostedMathFunc(ctx: CodegenContext, builtin: StdlibMathBuiltin): number {
  const ir = buildBuiltinIr(builtin);

  const resolver: IrLowerResolver = {
    resolveFunc(ref) {
      const idx = ctx.funcMap.get(ref.name);
      if (idx === undefined) {
        throw new Error(
          `stdlib-selfhost: ${builtin.name} calls "${ref.name}" but it is not registered yet — ` +
            `check emitInlineMathFunctions phase ordering`,
        );
      }
      return idx;
    },
    resolveGlobal(ref) {
      throw new Error(`stdlib-selfhost: ${builtin.name} must not reference globals (got "${ref.name}")`);
    },
    resolveType(ref) {
      throw new Error(`stdlib-selfhost: ${builtin.name} must not reference named types (got "${ref.name}")`);
    },
    internFuncType(type) {
      return addFuncType(ctx, type.params, type.results, type.name);
    },
  };

  const { func } = lowerIrFunctionToWasm(ir, resolver);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: builtin.name,
    typeIdx: func.typeIdx,
    locals: func.locals,
    body: func.body,
    exported: false,
  });
  ctx.funcMap.set(builtin.name, funcIdx);
  return funcIdx;
}
