// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2956 slice L1 — the LINEAR backend consumes the IR front-end.
//
// `--target linear` historically branched ABOVE the IR (compiler.ts hands the
// AST straight to `generateLinearModule`), so the selector / from-ast / lower
// pipeline never ran for linear compiles. This module is the linear driver
// for IR-claimed functions: for each top-level FunctionDeclaration the
// selector claims, it builds IR ONCE via the SAME shared front-end the WasmGC
// path uses (`planIrCompilation` → `lowerFunctionAstToIr` → `verifyIrFunction`
// → `verifyIrBackendLegality("linear")`) and lowers it through the
// `LinearEmitter` (#1714/#2954) into a ready-to-insert `WasmFunction`.
// Everything that does not fit demotes — with a bucketed reason — to the
// linear DIRECT path, which remains the module driver and default.
//
// GATING (slice L1): the overlay only runs when `JS2WASM_LINEAR_IR=1` is set
// (mirrors the #2980 `JS2WASM_ASYNC_CARRIER_WIDEN` instrument pattern). Flag
// off ⇒ `generateLinearModule` is byte-identical to before this module
// existed. The default-ON flip is slice L4 (see the #2956 slice map).
//
// DESIGN NOTE — relation to the ratified L0 (adapter extraction): the #2956
// spec's L0 splits `src/ir/integration.ts` into a backend-neutral core + an
// `IrBackendIntegration` adapter. This driver deliberately does NOT touch
// integration.ts: every primitive it calls (`planIrCompilation`,
// `lowerFunctionAstToIr`, `verifyIrFunction`, `verifyIrBackendLegality`,
// `lowerIrFunctionBody`) is ALREADY backend-neutral and imported from its own
// module — nothing here duplicates integration.ts's selection/typeMap/report
// logic (the drift-clone the spec forbids). When L0/#3029-S3 lands, this
// driver becomes the `LinearIntegration` adapter implementation nearly
// verbatim; extracting the interface with TWO live consumers in view (this
// one and the WasmGC one) yields a better cut than a one-consumer refactor.
// Recorded in plan/issues/2956 §"Execution status".
//
// SLICE-1 RESOLVER SCOPE: only the four REQUIRED `IrLowerResolver` methods
// are implemented (resolveFunc / resolveGlobal / resolveType /
// internFuncType) — name-based over the linear module tables (`ctx.funcMap`,
// `ctx.moduleGlobals`, `ctx.mod.types`). Every optional shape hook
// (union/boxed/object/closure/refcell/class/vec/string) is ABSENT: per the
// documented resolver contract a function whose IR demands a missing hook
// fails at lowering — and the linear legality gate (#2954,
// `verifyIrBackendLegality(fn, "linear")`) rejects such functions FIRST, so
// the absence is defense-in-depth, not a user-visible throw. Vec reads are
// legal for the LinearEmitter but stay demoted in slice 1 because from-ast's
// vec TYPING needs a linear `resolveVec` (an i32-pointer lowering handle,
// not the WasmGC struct handle) — that is slice L2 territory (#1804).

import { ts } from "../../ts-api.js";
import type { LinearContext } from "../../codegen-linear/context.js";
import { lowerFunctionAstToIr, typeNodeToIr } from "../from-ast.js";
import { lowerIrFunctionBody, type IrLowerResolver } from "../lower.js";
import type { IrFuncRef, IrGlobalRef, IrType, IrTypeRef } from "../nodes.js";
import { planIrCompilation } from "../select.js";
import type { FuncTypeDef, Instr, ValType, WasmFunction } from "../types.js";
import { verifyIrFunction } from "../verify.js";
import { verifyIrBackendLegality } from "./legality.js";
import { LinearEmitter } from "./linear-emitter.js";

/** One demoted claim: which function, and the bucketed reason. */
export interface LinearIrRejection {
  readonly func: string;
  /** Stable bucket key for the ratchet (scripts/check-linear-ir.mjs). */
  readonly reason: string;
  /** First error message — diagnostic detail, NOT part of the bucket key. */
  readonly detail?: string;
}

export interface LinearIrResult {
  /** name → IR-lowered function, ready to insert at the pre-assigned slot. */
  readonly funcs: Map<string, WasmFunction>;
  readonly compiled: readonly string[];
  readonly rejected: readonly LinearIrRejection[];
}

/** Slice-L1 gate: the overlay runs only under `JS2WASM_LINEAR_IR=1`. */
export function linearIrEnabled(): boolean {
  return typeof process !== "undefined" && process.env?.JS2WASM_LINEAR_IR === "1";
}

// Report side-channel for the ratchet harness (scripts/check-linear-ir.mjs):
// compiles are single-threaded within one process, so the harness reads the
// last module's report right after `compile()` returns. Deliberately NOT on
// the public CompileResult surface for slice 1.
let lastReport: LinearIrResult | undefined;
export function getLastLinearIrReport(): LinearIrResult | undefined {
  return lastReport;
}

/**
 * Build + lower every selector-claimed top-level FunctionDeclaration for the
 * LINEAR backend. Pure precompute: mutates nothing on `ctx.mod` except
 * interning func types (append-only, deduped); the caller inserts the
 * returned functions at their pre-assigned `ctx.funcMap` slots.
 */
export function compileLinearIrFunctions(ctx: LinearContext, sourceFile: ts.SourceFile): LinearIrResult {
  const funcs = new Map<string, WasmFunction>();
  const compiled: string[] = [];
  const rejected: LinearIrRejection[] = [];
  const result: LinearIrResult = { funcs, compiled, rejected };
  lastReport = result;

  const selection = planIrCompilation(sourceFile, { experimentalIR: true });
  if (selection.funcs.size === 0) return result;

  const resolver = makeLinearIrResolver(ctx);
  const emitter = new LinearEmitter();

  const claimedDecls: { name: string; decl: ts.FunctionDeclaration; exported: boolean }[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue;
    const name = stmt.name.text;
    if (!selection.funcs.has(name)) continue;
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    claimedDecls.push({ name, decl: stmt, exported });
  }
  if (claimedDecls.length === 0) return result;

  // Cross-function calls: from-ast resolves a top-level callee through
  // `calleeTypes`. The WasmGC integration seeds it from the Phase-2 TypeMap;
  // slice L1 seeds it by FIXPOINT instead — a successful build contributes
  // its own signature (`main.params[].type` / `main.resultTypes[0]`), and
  // functions that failed ONLY on a not-yet-known callee are retried with
  // the enriched map. Bounded by the claim count (each round must compile
  // at least one new function to continue).
  const calleeTypes = new Map<string, { params: readonly IrType[]; returnType: IrType | null }>();
  const lowered = new Map<string, WasmFunction>();
  const lastFailure = new Map<string, LinearIrRejection>();
  let pending = claimedDecls;

  // Pre-seed `calleeTypes` from ANNOTATIONS with from-ast's own primitive
  // mapping (`typeNodeToIr`) so SELF- and mutually-recursive claims (fib!)
  // resolve their own signature during the first build. Only fully-annotated
  // primitive signatures seed; anything else is left to the fixpoint below
  // (a wrong/absent seed just demotes, never mis-compiles — from-ast checks
  // the seed against annotations via `resolveIrType`).
  for (const { name, decl } of claimedDecls) {
    try {
      const params = decl.parameters.map((p) => typeNodeToIr(p.type, `pre-seed param of ${name}`));
      const returnType =
        decl.type === undefined || decl.type.kind === ts.SyntaxKind.VoidKeyword
          ? null
          : typeNodeToIr(decl.type, `pre-seed return of ${name}`);
      calleeTypes.set(name, { params, returnType });
    } catch {
      // Unannotated / non-primitive signature — no seed; the fixpoint may
      // still supply it from a successful build.
    }
  }

  for (let round = 0; round <= claimedDecls.length && pending.length > 0; round++) {
    const next: typeof pending = [];
    let progressed = false;

    for (const { name, decl, exported } of pending) {
      try {
        // Build — the SAME shared from-ast the WasmGC IR path uses. No
        // resolver is passed: shape-dependent lowerings (vec/string/object/
        // closure) throw inside from-ast and demote here (`build`), which is
        // correct for the slice-1 numeric/control-flow scope.
        const { main, lifted } = lowerFunctionAstToIr(decl, {
          checker: ctx.checker,
          exported,
          funcName: name,
          calleeTypes,
        });

        // Slice 1 lowers into PRE-ASSIGNED slots only; a build that
        // synthesizes lifted closures needs fresh slots (the WasmGC
        // integration's synthesized-func path) — demote until closures are
        // in linear scope.
        if (lifted.length > 0) {
          lastFailure.set(name, { func: name, reason: "lifted-closures" });
          progressed = true; // terminal — do not retry
          continue;
        }

        const verifyErrors = verifyIrFunction(main);
        if (verifyErrors.length > 0) {
          lastFailure.set(name, { func: name, reason: "verify", detail: verifyErrors[0]?.message });
          progressed = true; // terminal
          continue;
        }

        // The linear legality gate (#2954) — the capability predicate the
        // spec prescribes. Reject BEFORE lowering so an unsupported surface
        // is a bucketed demotion, not a lowering throw.
        const legality = verifyIrBackendLegality(main, "linear");
        if (legality.length > 0) {
          lastFailure.set(name, {
            func: name,
            reason: `illegal:${bucketFromLegalityMessage(legality[0]!.message)}`,
            detail: legality[0]?.message,
          });
          progressed = true; // terminal
          continue;
        }

        const body = lowerIrFunctionBody<Instr[]>(main, resolver, emitter);
        lowered.set(name, {
          name: body.name,
          typeIdx: body.typeIdx,
          locals: body.locals,
          body: body.body,
          exported: body.exported,
        });
        calleeTypes.set(name, {
          params: main.params.map((p) => p.type),
          returnType: main.resultTypes.length > 0 ? main.resultTypes[0]! : null,
        });
        lastFailure.delete(name);
        progressed = true;
      } catch (e) {
        // Fail-safe demote: the linear DIRECT path compiles this function
        // exactly as it does today (the overlay only ever ADDS capability).
        // A "call to unknown function" may resolve in a later round once
        // the callee's signature lands in `calleeTypes` — keep it pending.
        lastFailure.set(name, { func: name, reason: "build", detail: e instanceof Error ? e.message : String(e) });
        next.push({ name, decl, exported });
      }
    }

    pending = next;
    if (!progressed) break; // fixpoint: nothing new compiled or terminally rejected
  }

  for (const { name } of claimedDecls) {
    const fn = lowered.get(name);
    if (fn) {
      funcs.set(name, fn);
      compiled.push(name);
    } else {
      const failure = lastFailure.get(name);
      if (failure) rejected.push(failure);
    }
  }

  return result;
}

/**
 * Stable ratchet bucket from a legality error message. The message shapes
 * come from `legality.ts` (`linearInstrError` / `linearValTypeError`):
 *   "linear backend does not support IR instruction 'X' …" → `instr-X`
 *   "linear backend does not support ValType 'K'"          → `valtype-K`
 *   "linear backend does not support const 'K'"            → `const-K`
 */
function bucketFromLegalityMessage(message: string): string {
  const instr = /IR instruction '([^']+)'/.exec(message);
  if (instr) return `instr-${instr[1]}`;
  const valtype = /ValType '([^']+)'/.exec(message);
  if (valtype) return `valtype-${valtype[1]}`;
  const constKind = /const '([^']+)'/.exec(message);
  if (constKind) return `const-${constKind[1]}`;
  return "other";
}

/**
 * The slice-1 linear `IrLowerResolver`: the four required, name-based
 * methods over the linear module tables. Optional shape hooks deliberately
 * absent — see the module header.
 */
function makeLinearIrResolver(ctx: LinearContext): IrLowerResolver {
  return {
    resolveFunc(ref: IrFuncRef): number {
      const idx = ctx.funcMap.get(ref.name);
      if (idx === undefined) {
        throw new Error(`linear-ir: no funcIdx for '${ref.name}' (selector claimed a call outside funcMap)`);
      }
      return idx;
    },
    resolveGlobal(ref: IrGlobalRef): number {
      const idx = ctx.moduleGlobals.get(ref.name);
      if (idx === undefined) {
        throw new Error(`linear-ir: no global for '${ref.name}'`);
      }
      return idx;
    },
    resolveType(ref: IrTypeRef): number {
      // Slice 1 carries no symbolic type refs (numeric/control-flow only) —
      // the legality gate rejects shape-typed functions before lowering.
      throw new Error(`linear-ir: symbolic type '${ref.name}' outside slice-1 scope`);
    },
    internFuncType(def: FuncTypeDef): number {
      // Dedupe against the linear module's type section (append-only, no
      // hoist pass on linear — the spec's "must not grow it per call").
      const sameValType = (a: ValType, b: ValType): boolean =>
        a.kind === b.kind && (a as { typeIdx?: number }).typeIdx === (b as { typeIdx?: number }).typeIdx;
      for (let i = 0; i < ctx.mod.types.length; i++) {
        const t = ctx.mod.types[i]!;
        if (t.kind !== "func") continue;
        if (t.params.length !== def.params.length || t.results.length !== def.results.length) continue;
        if (
          t.params.every((p, j) => sameValType(p, def.params[j]!)) &&
          t.results.every((r, j) => sameValType(r, def.results[j]!))
        ) {
          return i;
        }
      }
      const idx = ctx.mod.types.length;
      ctx.mod.types.push(def);
      return idx;
    },
  };
}
