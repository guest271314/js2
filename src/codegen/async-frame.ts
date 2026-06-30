// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host-free async-frame substrate (#2895 PATH B, slice 1 — foundation).
 *
 * This is the **frame-layout layer** of the standalone/WASI async drive: it
 * registers the per-async-function `$AsyncFrame` state struct and the
 * {@link AsyncFrameInfo} that the resume-function emitter (next slice) consumes.
 * It deliberately mirrors the Wasm-native **generator** substrate
 * (`generators-native.ts` `buildNativeGeneratorInfo`) so both suspendable
 * lowerings share one frame ABI ({@link import("./frame-core.js").FrameLayout})
 * and one set of spill helpers (`frame-core.ts`) instead of forking.
 *
 * **Why a separate drive layer at all** (the measured #2865 AG0 root cause): a
 * *genuinely-pending* await — a promise that only settles on a later microtask
 * (an executor that resolves async, `Promise.all` of pending promises, a `.then`
 * chain observed across a microtask) — cannot be served by AG0's one-level
 * `$Promise.value` unwrap (`expressions.ts` `emitStandaloneAwaitUnwrap`): the
 * value is simply not present during the synchronous body execution. PATH B
 * builds a real resumable frame: at an await we spill live locals into the
 * frame, register a reaction (a resume-step funcref + the frame) on the awaited
 * `$Promise`'s callback list, and return the result `$Promise`; the microtask
 * drain resumes the frame at the saved state with the settled value. The
 * `$Promise` + reaction-node + microtask-ring + settle substrate already exists
 * (`async-scheduler.ts`), so this layer only adds the *frame* and the resume
 * trampoline; it reuses the scheduler verbatim via {@link
 * import("./async-scheduler.js").ensureAsyncDriveRuntime}.
 *
 * **Slice scope.** This file lands the inert foundation (predicate + frame
 * struct + info builder). It is NOT yet wired into `function-body.ts`, so
 * compilation output is byte-identical — exactly the #2384 frame-core extraction
 * pattern. The resume-function emitter, await-suspend lowering, settle-on-return,
 * call-site allocation, and the runner microtask-drain hook follow in the next
 * slices, and the broad `isStandalonePromiseActive` gate is re-widened to
 * `standalone` only *together with* that drive layer (re-widening it before the
 * drive layer exists is precisely the AG0 −31 regression).
 */
import { ts, forEachChild } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";
import { PARAM_FIELD_OFFSET, SENT_FIELD, MODE_FIELD, ERROR_FIELD, sanitizeTypeName } from "./frame-core.js";
import type { AsyncCpsPlan } from "./async-cps.js";
import { splitBodyAtAwait } from "./async-cps.js";
import { resolveSpillLocalValType } from "./statements/variables.js";

/**
 * Is the host-free async **drive layer** (#2895 PATH B) active for this module?
 *
 * Gated on the host-free targets — `--target standalone` and `--target wasi` —
 * where the JS-host async-CPS imports (`Promise_resolve`/`Promise_then2`/
 * `__make_callback`) are unavailable, so a genuinely-suspending async function
 * must be driven by the native `$Promise` + microtask substrate instead. The
 * JS-host path keeps its existing CPS state machine (`async-cps.ts`).
 *
 * NOTE: this is the *drive-layer* gate (does this fn get a real resumable
 * frame), distinct from {@link import("./async-scheduler.js").isStandalonePromiseActive}
 * (the *carrier* gate: does `await`/`Promise.resolve` use the native `$Promise`).
 * The carrier gate stays `wasi`-only until this drive layer makes a native async
 * result observable to the `flags:[async]` harness — see the file header.
 */
export function isAsyncDriveActive(ctx: CodegenContext): boolean {
  return ctx.standalone === true || ctx.wasi === true;
}

/**
 * Per-async-function frame metadata produced by {@link buildAsyncFrameInfo} and
 * consumed by the resume-function emitter (next slice). Structurally satisfies
 * {@link import("./frame-core.js").FrameLayout} (`stateTypeIdx`, `modeFieldIdx`,
 * `spillNames`, `spillTypes`, `spillFieldOffset`) so the shared `frame-core.ts`
 * spill/state helpers drive it with no wrapper — identical to how
 * `NativeGeneratorInfo` satisfies the same interface.
 */
export interface AsyncFrameInfo {
  /** Source function name (the `__async_resume_f<name>` / struct name stem). */
  functionName: string;
  /** The async function/method declaration this frame belongs to. */
  decl: ts.FunctionLikeDeclaration;
  /** Per-frame `$AsyncFrame_<name>` state struct typeIdx. */
  stateTypeIdx: number;
  /** Field index of the i32 resume mode (`MODE_FIELD`). FrameLayout. */
  modeFieldIdx: number;
  /** Field index of the settled-awaited-value slot (`SENT_FIELD`). */
  sentFieldIdx: number;
  /** Field index of the rejection-reason slot (`ERROR_FIELD`). */
  errorFieldIdx: number;
  /** Captured-parameter names, aligned 1:1 with `paramTypes`. */
  paramNames: string[];
  /** Wasm ValType of each captured parameter. */
  paramTypes: ValType[];
  /** First struct field index of the captured params (`PARAM_FIELD_OFFSET`). */
  paramFieldOffset: number;
  /** Names of body locals live across the await, spilled into the frame. FrameLayout. */
  spillNames: string[];
  /** Wasm ValType of each spilled local, aligned 1:1 with `spillNames`. FrameLayout. */
  spillTypes: ValType[];
  /** First struct field index where spills start. FrameLayout. */
  spillFieldOffset: number;
  /** Field index of the result `$Promise` the async fn returns / settles. */
  resultPromiseFieldIdx: number;
  /** `$Promise` struct typeIdx (the result-promise field's element type). */
  promiseTypeIdx: number;
  /** `__async_resume_f<name>(frame) -> void` funcIdx — filled by the emitter slice. */
  resumeFuncIdx?: number;
  /** `__async_step_fulfill_f<name>(caps, value) -> externref` funcIdx — emitter slice. */
  stepFulfillFuncIdx?: number;
  /** `__async_step_reject_f<name>(caps, value) -> externref` funcIdx — emitter slice. */
  stepRejectFuncIdx?: number;
}

/**
 * Build (and register the state struct for) the `$AsyncFrame` of one async
 * function. Mirrors `buildNativeGeneratorInfo`: fixed leading frame fields
 * (`STATE`/`SENT`/`MODE`/`ABRUPT`/`ERROR`), then the captured params at
 * `PARAM_FIELD_OFFSET`, then the live-across-await spills, then a trailing
 * result-`$Promise` field (placed after spills so the `spillFieldOffset`
 * indexing the shared helpers use is unaffected — same discipline as the
 * generator `yield*` delegation slots).
 *
 * Field ValTypes:
 *   - `STATE`/`MODE`: i32 (the `br_table` selector + resume mode).
 *   - `SENT`/`ABRUPT`/`ERROR`: externref. Unlike a numeric generator's carrier,
 *     an awaited value is always boxed (`$Promise.value` is externref), so the
 *     settled value, the (unused-here) `.return` carrier, and the rejection
 *     reason are all externref.
 *   - params/spills: their natural Wasm ValType.
 *   - result promise: `(ref $Promise)`.
 *
 * @param promiseTypeIdx the module's `$Promise` struct typeIdx (from
 *   `getOrRegisterPromiseType` — caller registers the drive runtime first so the
 *   type exists and the funcIdx baseline is stable).
 */
export function buildAsyncFrameInfo(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
  paramNames: string[],
  paramTypes: ValType[],
  promiseTypeIdx: number,
): AsyncFrameInfo {
  const functionName = asyncFnName(decl);

  // Fixed leading frame fields (frame-core ABI). SENT/ABRUPT/ERROR are externref
  // for async (awaited values are always boxed), unlike the generator carrier.
  const stateFields: { name: string; type: ValType; mutable: boolean }[] = [
    { name: "state", type: { kind: "i32" }, mutable: true },
    { name: "sent", type: { kind: "externref" }, mutable: true },
    { name: "mode", type: { kind: "i32" }, mutable: true },
    { name: "abrupt", type: { kind: "externref" }, mutable: true },
    { name: "error", type: { kind: "externref" }, mutable: true },
  ];

  for (let i = 0; i < paramTypes.length; i++) {
    stateFields.push({ name: `param_${paramNames[i] ?? i}`, type: paramTypes[i]!, mutable: false });
  }

  const spillFieldOffset = PARAM_FIELD_OFFSET + paramTypes.length;
  const { spillNames, spillTypes } = computeAsyncSpills(ctx, decl, plan, paramNames);
  for (let i = 0; i < spillNames.length; i++) {
    stateFields.push({ name: `spill_${spillNames[i]}`, type: spillTypes[i]!, mutable: true });
  }

  // Trailing result-promise field — after spills so `spillFieldOffset` is stable.
  const resultPromiseFieldIdx = spillFieldOffset + spillNames.length;
  stateFields.push({ name: "result_promise", type: { kind: "ref", typeIdx: promiseTypeIdx }, mutable: true });

  const stateName = `$AsyncFrame_${sanitizeTypeName(functionName)}`;
  const stateTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: stateName, fields: stateFields });
  ctx.structMap.set(stateName, stateTypeIdx);
  ctx.typeIdxToStructName.set(stateTypeIdx, stateName);
  ctx.structFields.set(stateName, stateFields);

  return {
    functionName,
    decl,
    stateTypeIdx,
    modeFieldIdx: MODE_FIELD,
    sentFieldIdx: SENT_FIELD,
    errorFieldIdx: ERROR_FIELD,
    paramNames,
    paramTypes,
    paramFieldOffset: PARAM_FIELD_OFFSET,
    spillNames,
    spillTypes,
    spillFieldOffset,
    resultPromiseFieldIdx,
    promiseTypeIdx,
  };
}

// ── internal ────────────────────────────────────────────────────────────────

/** A stable, sanitizable name for the async function (for the struct + resume fn). */
function asyncFnName(decl: ts.FunctionLikeDeclaration): string {
  if (ts.isFunctionDeclaration(decl) && decl.name) return decl.name.text;
  if ((ts.isMethodDeclaration(decl) || ts.isFunctionExpression(decl)) && decl.name && ts.isIdentifier(decl.name)) {
    return decl.name.text;
  }
  // Arrow / anonymous — synthesize from source position (unique within a module).
  const pos = decl.pos >= 0 ? decl.pos : 0;
  return `anon_${pos}`;
}

/**
 * The body locals that are live across the (single, slice-1) await and so must
 * be spilled into the frame. Mirrors the generator's `bodySpills`: the
 * live-after-await set MINUS params (already captured in param fields) MINUS the
 * resume binding (`const x = await P` — `x` is delivered fresh from `SENT_FIELD`
 * on resume, never snapshotted at suspend time). Spill ValTypes are resolved
 * from the declaring `VariableDeclaration` via `resolveSpillLocalValType`,
 * defaulting to externref when a precise type is not recoverable.
 */
function computeAsyncSpills(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
  paramNames: string[],
): { spillNames: string[]; spillTypes: ValType[] } {
  if (plan.awaitPoints.length === 0) return { spillNames: [], spillTypes: [] };
  const live = plan.liveAfterAwait.get(plan.awaitPoints[0]!) ?? new Set<string>();
  const split = splitBodyAtAwait(decl, plan);
  const resumeBindingName = split?.resumeBinding?.name;
  const paramSet = new Set(paramNames);

  const declByName = collectVarDeclsByName(decl);
  const spillNames: string[] = [];
  const spillTypes: ValType[] = [];
  for (const name of live) {
    if (paramSet.has(name)) continue;
    if (resumeBindingName !== undefined && name === resumeBindingName) continue;
    const declNode = declByName.get(name);
    const resolved = declNode ? resolveSpillLocalValType(ctx, declNode) : null;
    spillNames.push(name);
    spillTypes.push(resolved ?? { kind: "externref" });
  }
  return { spillNames, spillTypes };
}

/** Map each body `var`/`let`/`const` declaration name → its declaration node. */
function collectVarDeclsByName(decl: ts.FunctionLikeDeclaration): Map<string, ts.VariableDeclaration> {
  const out = new Map<string, ts.VariableDeclaration>();
  const body = decl.body;
  if (body === undefined) return out;
  const walk = (node: ts.Node): void => {
    if (isNestedScope(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      out.set(node.name.text, node);
    }
    forEachChild(node, walk);
  };
  forEachChild(body, walk);
  return out;
}

function isNestedScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}
