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
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import {
  PARAM_FIELD_OFFSET,
  STATE_FIELD,
  SENT_FIELD,
  MODE_FIELD,
  MODE_THROW,
  ERROR_FIELD,
  sanitizeTypeName,
  storeSpills,
  setStateI32FromConst,
  defaultSpillInstr,
} from "./frame-core.js";
import { ensureExnTag } from "./registry/imports.js";
import type { AsyncCpsPlan, LinearAwaitPlan } from "./async-cps.js";
import { planLinearAwaits, awaitedExprIsPromiseCombinator, ASYNC_CPS_ENABLED } from "./async-cps.js";
import { resolveSpillLocalValType } from "./statements/variables.js";
import { allocLocal } from "./context/locals.js";
import { addFuncType } from "./registry/types.js";
import { compileExpression, compileStatement, coerceType } from "./shared.js";
import { reportError } from "./context/errors.js";
import { resolveWasmType } from "./index.js";
import {
  ensureAsyncDriveRuntime,
  getOrRegisterPromiseType,
  type AsyncDriveRuntime,
  PROMISE_STATE_PENDING,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_REJECTED,
} from "./async-scheduler.js";

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
 * The Wasm ValType a resume binding (`const x = await P`) settles to — the
 * coercion target the continuation writes `SENT_FIELD` into, and (when the
 * binding survives a later await) the type of its frame spill field. Resolved
 * consistently in ONE place so the spill field and the resume-function local
 * agree and round-trip through `struct.get`/`struct.set`.
 */
function resumeBindingValType(ctx: CodegenContext, rb: { name: string; type: ts.TypeNode | undefined }): ValType {
  return rb.type ? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(rb.type)) : { kind: "externref" };
}

/**
 * ValTypes that spill safely in slice 1: they have a valid inert
 * {@link defaultSpillInstr} AND survive a mutable-field round-trip. Non-null GC
 * refs are excluded — their field default would be a `ref.null` of a non-null
 * type (invalid Wasm) — so a resume binding of such a type that must be spilled
 * makes the fn fall back to the legacy path (a later slice widens this).
 */
function isSpillSafeType(t: ValType): boolean {
  return t.kind === "i32" || t.kind === "f64" || t.kind === "i64" || t.kind === "externref" || t.kind === "ref_null";
}

/** Is `name` (a resume binding delivered by await `k`) read after some LATER
 *  await (`j > k`)? If so it must be preserved across that await's suspend. */
function bindingLiveAcrossLaterAwait(name: string, k: number, plan: AsyncCpsPlan): boolean {
  for (let j = k + 1; j < plan.awaitPoints.length; j++) {
    const live = plan.liveAfterAwait.get(plan.awaitPoints[j]!);
    if (live && live.has(name)) return true;
  }
  return false;
}

/**
 * Host-free drive-layer eligibility (#2906) — the standalone/wasi analogue of
 * {@link import("./async-cps.js").asyncFnNeedsCps}. True when the async fn
 * genuinely suspends AND its body is a LINEAR multi-await shape the general
 * resume machine can drive ({@link planLinearAwaits}) AND every resume binding
 * that must survive a later await has a spill-safe type.
 *
 * **Single-await parity.** For exactly one canonical await this returns the same
 * verdict as `asyncFnNeedsCps` (same real-suspension + Promise-combinator gates;
 * a single await's binding is never crossed by a later await so the type gate is
 * inert), so the wasi single-await routing decision is unchanged by #2906 — only
 * the emitted resume machine generalizes.
 */
export function asyncFnNeedsDrive(ctx: CodegenContext, fn: ts.FunctionLikeDeclaration, plan: AsyncCpsPlan): boolean {
  if (!ASYNC_CPS_ENABLED) return false;
  if (plan.awaitPoints.length === 0) return false;
  const anyRealSuspension = plan.awaitPoints.some((a) => plan.awaitedStaticallyResolved.get(a) !== true);
  if (!anyRealSuspension) return false; // fully await-elidable → sync + resolved promise
  const linear = planLinearAwaits(fn, plan);
  if (linear === null) return false;
  // Parity with asyncFnNeedsCps: a lone `await Promise.all(...)`/`.race`/… already
  // yields a real Promise — keep it on the legacy identity path.
  if (linear.segments.length === 1 && awaitedExprIsPromiseCombinator(linear.segments[0]!.awaitedExpr)) return false;
  // Slice-1 type gate: a resume binding spilled across a later await needs a
  // spill-safe type (see isSpillSafeType).
  for (let k = 0; k < linear.segments.length; k++) {
    const rb = linear.segments[k]!.resumeBinding;
    if (!rb) continue;
    if (!bindingLiveAcrossLaterAwait(rb.name, k, plan)) continue;
    if (!isSpillSafeType(resumeBindingValType(ctx, rb))) return false;
  }
  return true;
}

/**
 * The body locals that are live across ANY await and so must be spilled into the
 * frame (the multi-await generalization of the generator's `bodySpills`).
 *
 * The spill set is the UNION, over every await `k`, of the locals live across
 * await `k`'s suspend, MINUS params (captured in param fields) and MINUS await
 * `k`'s OWN resume binding (delivered fresh from `SENT_FIELD` on resume, never
 * snapshotted at suspend time). A resume binding from an EARLIER await that
 * survives a later await IS spilled — it is an ordinary live local at that later
 * suspend. Iterating awaits in order over insertion-ordered `Set`s and skipping
 * only each await's own binding keeps a SINGLE-await body's spill list
 * byte-identical to the pre-#2906 computation.
 *
 * Spill ValTypes: a resume-binding name uses {@link resumeBindingValType} (so the
 * field matches the SENT-coercion target); any other local uses
 * `resolveSpillLocalValType`, defaulting to externref.
 */
function computeAsyncSpills(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
  paramNames: string[],
): { spillNames: string[]; spillTypes: ValType[] } {
  const linear = planLinearAwaits(decl, plan);
  if (linear === null) return { spillNames: [], spillTypes: [] };
  const paramSet = new Set(paramNames);

  const rbTypeByName = new Map<string, ValType>();
  for (const seg of linear.segments) {
    if (seg.resumeBinding) rbTypeByName.set(seg.resumeBinding.name, resumeBindingValType(ctx, seg.resumeBinding));
  }

  const declByName = collectVarDeclsByName(decl);
  const spillNames: string[] = [];
  const spillTypes: ValType[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < linear.segments.length; k++) {
    const live = plan.liveAfterAwait.get(plan.awaitPoints[k]!) ?? new Set<string>();
    const ownBinding = linear.segments[k]!.resumeBinding?.name;
    for (const name of live) {
      if (paramSet.has(name)) continue;
      if (ownBinding !== undefined && name === ownBinding) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const rbType = rbTypeByName.get(name);
      if (rbType !== undefined) {
        spillNames.push(name);
        spillTypes.push(rbType);
        continue;
      }
      const declNode = declByName.get(name);
      const resolved = declNode ? resolveSpillLocalValType(ctx, declNode) : null;
      spillNames.push(name);
      spillTypes.push(resolved ?? { kind: "externref" });
    }
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

// ── PATH B slice 1b: resume function + step adapters + call-site shim ─────────

/**
 * Build (idempotently) the host-free async **resume function**
 * `__async_resume_f<name>(frame) -> void` and its two microtask **step
 * adapters** for one async function. Returns the resume funcIdx.
 *
 * The resume function is a **general N-state machine** (#2906) driven by
 * `frame.STATE_FIELD` over an ordered list of suspend segments
 * ({@link planLinearAwaits}) — the multi-await generalization of the pre-#2906
 * 2-state machine. It mirrors the Wasm-native generator trampoline
 * (`generators-native.ts emitTrampoline`): a `block { loop { if-chain } }` that
 * dispatches on STATE, where a synchronously-settled await advances STATE and
 * `br`s back to re-dispatch (chaining fast-path awaits within one call) and a
 * genuinely-pending await suspends with a `return`.
 *
 * For N awaits there are N+1 states:
 *   - state s (0 ≤ s < N): [for s≥1] re-throw a rejected predecessor await + bind
 *     its value from `SENT_FIELD`; run the lead statements; evaluate await s's
 *     operand and assimilate it to a `$Promise`. FULFILLED → deliver value to
 *     SENT, STATE=s+1, `br` re-dispatch. REJECTED → stash reason in ERROR +
 *     MODE=THROW, STATE=s+1, `br` (the next state's prelude re-throws). PENDING →
 *     `storeSpills`, STATE=s+1, register the reaction (the SAME two step adapters
 *     for every state — they only deliver SENT/ERROR then call resume, which
 *     routes by STATE), `return`. A non-`$Promise` operand is delivered straight.
 *   - state N (final): re-throw / bind the last await's value, then run the tail
 *     (`return v` settles `frame.result_promise` via the `asyncDriveReturn` hook;
 *     fall-through settles undefined). `return await P` settles with SENT directly.
 *
 * Uses the generator slot-reservation discipline (#2079/#1677/#1809): the resume
 * function and both step adapters reserve their funcIdx slots with placeholder
 * bodies BEFORE the resume body is emitted, because `compileStatement` on the
 * lead/tail statements can lazily append helper functions to `ctx.mod.functions`
 * — a stale capture would otherwise repoint every baked `call`/`ref.func`. The
 * N-segment body widens that window (more helpers) but the discipline is the same.
 */
export function ensureAsyncResumeFunction(ctx: CodegenContext, info: AsyncFrameInfo, plan: AsyncCpsPlan): number {
  if (info.resumeFuncIdx !== undefined) return info.resumeFuncIdx;

  const linear = planLinearAwaits(info.decl, plan);
  if (linear === null) {
    reportError(ctx, info.decl, "internal: async-frame resume built on an unsupported body shape (#2906 slice 1)");
    info.resumeFuncIdx = -1;
    return -1;
  }

  const rt = ensureAsyncDriveRuntime(ctx);
  const frameRef: ValType = { kind: "ref", typeIdx: info.stateTypeIdx };
  const stem = sanitizeTypeName(info.functionName);

  // Reserve slots: resume fn, then the two step adapters. The microtask wrapper
  // ABI is (caps externref, value externref) -> externref (result dropped). N
  // states reuse the SAME two adapters (no per-state ABI change — #2906).
  const resumeName = `__async_resume_f${stem}`;
  const resumeTypeIdx = addFuncType(ctx, [frameRef], [], `${resumeName}_type`);
  const stepName = `__async_step_f${stem}`;
  const stepTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    `${stepName}_type`,
  );

  const resumeFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  info.resumeFuncIdx = resumeFuncIdx;
  ctx.funcMap.set(resumeName, resumeFuncIdx);
  const resumePlaceholder: WasmFunction = {
    name: resumeName,
    typeIdx: resumeTypeIdx,
    locals: [],
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(resumePlaceholder);

  const stepFulfillFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  info.stepFulfillFuncIdx = stepFulfillFuncIdx;
  ctx.funcMap.set(`${stepName}_fulfill`, stepFulfillFuncIdx);
  ctx.mod.functions.push({
    name: `${stepName}_fulfill`,
    typeIdx: stepTypeIdx,
    locals: buildStepAdapterLocals(info),
    body: buildStepAdapterBody(info, resumeFuncIdx, /*reject*/ false),
    exported: false,
  });

  const stepRejectFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  info.stepRejectFuncIdx = stepRejectFuncIdx;
  ctx.funcMap.set(`${stepName}_reject`, stepRejectFuncIdx);
  ctx.mod.functions.push({
    name: `${stepName}_reject`,
    typeIdx: stepTypeIdx,
    locals: buildStepAdapterLocals(info),
    body: buildStepAdapterBody(info, resumeFuncIdx, /*reject*/ true),
    exported: false,
  });

  // ── Build the resume function body. ──
  const resumeFctx: FunctionContext = {
    name: resumeName,
    params: [{ name: "__frame", type: frameRef }],
    locals: [],
    localMap: new Map([["__frame", 0]]),
    returnType: null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  const frameLocal = 0;

  // Load captured params from the frame into locals.
  for (let i = 0; i < info.paramNames.length; i++) {
    const idx = allocLocal(resumeFctx, info.paramNames[i]!, info.paramTypes[i]!);
    resumeFctx.body.push({ op: "local.get", index: frameLocal });
    resumeFctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.paramFieldOffset + i });
    resumeFctx.body.push({ op: "local.set", index: idx });
  }
  // Load spills from the frame into locals (overwritten by a segment's lead on
  // first entry into its owning state; restored from the frame on resume).
  for (let i = 0; i < info.spillNames.length; i++) {
    const idx = allocLocal(resumeFctx, info.spillNames[i]!, info.spillTypes[i]!);
    resumeFctx.body.push({ op: "local.get", index: frameLocal });
    resumeFctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + i });
    resumeFctx.body.push({ op: "local.set", index: idx });
  }
  // Load the result promise into a local; wire the `return` settle hook.
  const resultPromiseLocal = allocLocal(resumeFctx, "__async_result", {
    kind: "ref",
    typeIdx: info.promiseTypeIdx,
  });
  resumeFctx.body.push({ op: "local.get", index: frameLocal });
  resumeFctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.resultPromiseFieldIdx });
  resumeFctx.body.push({ op: "local.set", index: resultPromiseLocal });
  resumeFctx.asyncDriveReturn = {
    resultPromiseLocal,
    promiseTypeIdx: info.promiseTypeIdx,
    fulfillFuncIdx: rt.fulfillFuncIdx,
  };

  // Resume-binding locals. A binding that survives a later await is ALREADY a
  // spill local (allocated above) — reuse that slot so the delivered SENT value
  // and the spilled/reloaded value share one local. A binding used only within
  // its own continuation gets a fresh delivery-only local. Typed via
  // `resumeBindingValType` (== the spill field type for the spilled ones).
  const bindingLocal = new Map<string, { local: number; type: ValType }>();
  for (const seg of linear.segments) {
    if (!seg.resumeBinding) continue;
    const t = resumeBindingValType(ctx, seg.resumeBinding);
    const existing = resumeFctx.localMap.get(seg.resumeBinding.name);
    const local = existing !== undefined ? existing : allocLocal(resumeFctx, seg.resumeBinding.name, t);
    bindingLocal.set(seg.resumeBinding.name, { local, type: t });
  }

  // Transient locals reused across every state arm (only one await is processed
  // per resume-call dispatch, so a single set suffices).
  const awaitedLocal = allocLocal(resumeFctx, "__async_awaited", { kind: "externref" });
  const pLocal = allocLocal(resumeFctx, "__async_p", { kind: "ref", typeIdx: info.promiseTypeIdx });
  const suspendedLocal = allocLocal(resumeFctx, "__async_suspended", { kind: "i32" });
  const exnTag = ensureExnTag(ctx);
  const reasonLocal = allocLocal(resumeFctx, "__async_reason", { kind: "externref" });
  const N = linear.segments.length;

  // Emit `SENT_FIELD → predecessor await's resume binding`, guarded by a
  // MODE_THROW re-throw of a rejected predecessor. `s` is the state whose
  // predecessor await is `s-1` (used by state s≥1 and the final state N).
  const emitDeliverPrev = (out: Instr[], s: number): void => {
    out.push({ op: "local.get", index: frameLocal });
    out.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: MODE_FIELD });
    out.push({ op: "i32.const", value: MODE_THROW });
    out.push({ op: "i32.eq" });
    out.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: frameLocal },
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD } as Instr,
        { op: "throw", tagIdx: exnTag } as Instr,
      ],
    } as Instr);
    const prev = linear.segments[s - 1]!;
    if (prev.resumeBinding) {
      const bl = bindingLocal.get(prev.resumeBinding.name)!;
      out.push({ op: "local.get", index: frameLocal });
      out.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD });
      coerceType(ctx, resumeFctx, { kind: "externref" }, bl.type);
      out.push({ op: "local.set", index: bl.local });
    }
  };

  // State s (0 ≤ s < N): run await s, then advance (br to re-dispatch) or suspend.
  const buildAwaitSegment = (s: number): Instr[] => {
    const seg = linear.segments[s]!;
    const saved = resumeFctx.body;
    ctx.liveBodies.add(saved);
    const out: Instr[] = [];
    resumeFctx.body = out;
    try {
      if (s >= 1) emitDeliverPrev(out, s);
      for (const stmt of seg.leadStmts) compileStatement(ctx, resumeFctx, stmt);

      const awaitedType = compileExpression(ctx, resumeFctx, seg.awaitedExpr);
      if (awaitedType !== null && awaitedType !== undefined) {
        coerceType(ctx, resumeFctx, awaitedType as ValType, { kind: "externref" });
      } else {
        out.push({ op: "ref.null.extern" } as Instr);
      }
      out.push({ op: "local.set", index: awaitedLocal });

      // Classify the assimilated value; set suspendedLocal + SENT/ERROR/MODE.
      // No `br` inside these nested ifs — the single advance/suspend `br`/`return`
      // is emitted flat below at a known control depth.
      out.push({ op: "i32.const", value: 0 });
      out.push({ op: "local.set", index: suspendedLocal });

      const deliverFromP: Instr[] = [
        { op: "local.get", index: frameLocal },
        { op: "local.get", index: pLocal },
        { op: "struct.get", typeIdx: info.promiseTypeIdx, fieldIdx: 1 } as Instr,
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD } as Instr,
      ];
      const rejectFromP: Instr[] = [
        { op: "local.get", index: frameLocal },
        { op: "local.get", index: pLocal },
        { op: "struct.get", typeIdx: info.promiseTypeIdx, fieldIdx: 1 } as Instr,
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD } as Instr,
        ...setStateI32FromConst(info, frameLocal, MODE_FIELD, MODE_THROW),
      ];
      const markPending: Instr[] = [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: suspendedLocal },
      ];
      const deliverPlain: Instr[] = [
        { op: "local.get", index: frameLocal },
        { op: "local.get", index: awaitedLocal },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD } as Instr,
      ];
      const pendingOrRejected: Instr[] = [
        { op: "local.get", index: pLocal },
        { op: "struct.get", typeIdx: info.promiseTypeIdx, fieldIdx: 0 } as Instr,
        { op: "i32.const", value: PROMISE_STATE_REJECTED },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: rejectFromP, else: markPending } as Instr,
      ];
      out.push(
        { op: "local.get", index: awaitedLocal },
        { op: "any.convert_extern" } as Instr,
        { op: "ref.test", typeIdx: info.promiseTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: awaitedLocal },
            { op: "any.convert_extern" } as Instr,
            { op: "ref.cast", typeIdx: info.promiseTypeIdx } as Instr,
            { op: "local.set", index: pLocal },
            { op: "local.get", index: pLocal },
            { op: "struct.get", typeIdx: info.promiseTypeIdx, fieldIdx: 0 } as Instr,
            { op: "i32.const", value: PROMISE_STATE_FULFILLED },
            { op: "i32.eq" },
            { op: "if", blockType: { kind: "empty" }, then: deliverFromP, else: pendingOrRejected } as Instr,
          ],
          else: deliverPlain,
        } as Instr,
      );

      // Advance-or-suspend. STATE = s+1 for both (suspend → resume enters s+1;
      // advance → re-dispatch enters s+1).
      out.push(...setStateI32FromConst(info, frameLocal, STATE_FIELD, s + 1));
      const suspendArm: Instr[] = [
        ...storeSpills(info, resumeFctx, frameLocal),
        // promise.callbacks = $PromiseCallback{stepFulfill, frame, stepReject, frame, promise.callbacks}
        { op: "local.get", index: pLocal },
        { op: "ref.func", funcIdx: info.stepFulfillFuncIdx! } as Instr,
        { op: "local.get", index: frameLocal },
        { op: "extern.convert_any" } as Instr,
        { op: "ref.func", funcIdx: info.stepRejectFuncIdx! } as Instr,
        { op: "local.get", index: frameLocal },
        { op: "extern.convert_any" } as Instr,
        { op: "local.get", index: pLocal },
        { op: "struct.get", typeIdx: info.promiseTypeIdx, fieldIdx: 2 } as Instr,
        { op: "struct.new", typeIdx: rt.callbackTypeIdx } as Instr,
        { op: "extern.convert_any" } as Instr,
        { op: "struct.set", typeIdx: info.promiseTypeIdx, fieldIdx: 2 } as Instr,
        { op: "return" },
      ];
      // Advance: `br` to the dispatch `loop` to re-enter at STATE=s+1. Control
      // depth from inside this `else`: br0 = this if, br1 = if(state==s), … ,
      // br(s+1) = if(state==0), br(s+2) = loop.
      const advanceArm: Instr[] = [{ op: "br", depth: s + 2 } as Instr];
      out.push({ op: "local.get", index: suspendedLocal });
      out.push({ op: "if", blockType: { kind: "empty" }, then: suspendArm, else: advanceArm } as Instr);
    } finally {
      resumeFctx.body = saved;
      ctx.liveBodies.delete(saved);
    }
    return out;
  };

  // State N (final): deliver the last await's value, then run the tail / settle.
  const buildFinalSegment = (): Instr[] => {
    const saved = resumeFctx.body;
    ctx.liveBodies.add(saved);
    const out: Instr[] = [];
    resumeFctx.body = out;
    try {
      emitDeliverPrev(out, N);
      const last = linear.segments[N - 1]!;
      if (last.isReturnAwait) {
        out.push({ op: "local.get", index: resultPromiseLocal });
        out.push({ op: "local.get", index: frameLocal });
        out.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD });
        out.push({ op: "call", funcIdx: rt.fulfillFuncIdx });
        out.push({ op: "drop" });
        out.push({ op: "return" });
      } else {
        for (const stmt of linear.tail) compileStatement(ctx, resumeFctx, stmt);
        out.push({ op: "local.get", index: resultPromiseLocal });
        out.push({ op: "ref.null.extern" } as Instr);
        out.push({ op: "call", funcIdx: rt.fulfillFuncIdx });
        out.push({ op: "drop" });
        out.push({ op: "return" });
      }
    } finally {
      resumeFctx.body = saved;
      ctx.liveBodies.delete(saved);
    }
    return out;
  };

  // Nested if-chain dispatch (`if(state==s){seg}else{…}`), mirroring the
  // generator trampoline. Recursion depth == stateId, so each arm's `br`-to-loop
  // depth is computed as `stateId + 2` inside `buildAwaitSegment`.
  const buildStateArm = (s: number): Instr[] => {
    if (s > N) return [{ op: "unreachable" } as Instr];
    const then = s === N ? buildFinalSegment() : buildAwaitSegment(s);
    return [
      { op: "local.get", index: frameLocal },
      { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
      { op: "i32.const", value: s },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then, else: buildStateArm(s + 1) } as Instr,
    ];
  };

  const savedFunc = ctx.currentFunc;
  ctx.currentFunc = resumeFctx;
  let chain: Instr[];
  try {
    chain = buildStateArm(0);
  } finally {
    ctx.currentFunc = savedFunc;
  }

  // (#2867 Gap 2) Throw → reject routing. A genuine throw — a bare `throw e`, or
  // a rejected await re-thrown by a state prelude's MODE_THROW arm — must settle
  // the result `$Promise` REJECTED, not escape uncaught (trap / strand pending).
  // Wrap the whole `block { loop { if-chain } }` dispatch in `try`/`catch $exn`.
  // Suspend / settle `return`s exit cleanly (a `return` in `try` skips `catch`),
  // so only a real throw reaches the handler.
  const dispatch: Instr[] = [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: chain } as Instr],
    } as Instr,
  ];
  resumeFctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: dispatch,
    catches: [
      {
        tagIdx: exnTag,
        body: [
          { op: "local.set", index: reasonLocal },
          { op: "local.get", index: resultPromiseLocal },
          { op: "local.get", index: reasonLocal },
          { op: "call", funcIdx: rt.rejectFuncIdx },
          { op: "drop" },
        ],
      },
    ],
  } as Instr);

  resumePlaceholder.locals = resumeFctx.locals;
  resumePlaceholder.body = resumeFctx.body;
  return resumeFuncIdx;
}

/** Step-adapter locals: param 0/1 = (caps, value); local 2 = the cast frame. */
function buildStepAdapterLocals(info: AsyncFrameInfo): { name: string; type: ValType }[] {
  return [{ name: "$frame", type: { kind: "ref", typeIdx: info.stateTypeIdx } }];
}

/**
 * `__async_step_f<name>_{fulfill,reject}(caps, value) -> externref`: cast caps
 * back to the frame, store the settled value into `SENT_FIELD` (and, for the
 * reject adapter, the reason into `ERROR_FIELD` + `MODE_FIELD=MODE_THROW`), then
 * call the resume function. This is the funcref enqueued on the awaited
 * promise's reaction list and run by the microtask drain.
 */
function buildStepAdapterBody(info: AsyncFrameInfo, resumeFuncIdx: number, reject: boolean): Instr[] {
  const capsLocal = 0;
  const valueLocal = 1;
  const frameLocal = 2;
  const body: Instr[] = [
    { op: "local.get", index: capsLocal },
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: info.stateTypeIdx } as Instr,
    { op: "local.set", index: frameLocal },
    // SENT_FIELD = value (the settled awaited value the continuation reads).
    { op: "local.get", index: frameLocal },
    { op: "local.get", index: valueLocal },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD } as Instr,
  ];
  if (reject) {
    // ERROR_FIELD = reason; MODE_FIELD = MODE_THROW (2). (Slice-1 surfaces the
    // reason via SENT for the fast path; the throw-on-rejected-await refinement
    // reads ERROR/MODE — wired here so the field is populated.)
    body.push(
      { op: "local.get", index: frameLocal },
      { op: "local.get", index: valueLocal },
      { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD } as Instr,
      ...setStateI32FromConst(info, frameLocal, MODE_FIELD, 2),
    );
  }
  body.push(
    { op: "local.get", index: frameLocal },
    { op: "call", funcIdx: resumeFuncIdx },
    { op: "ref.null.extern" } as Instr, // dropped by the drain
  );
  return body;
}

/**
 * Call-site / function-body shim (#2895 slice 1c entry point). Emitted in place
 * of the normal statement loop for a host-free async function that genuinely
 * suspends: allocate the `$AsyncFrame` (params spilled into fields, a fresh
 * pending result `$Promise`), kick the resume function once (runs entry to the
 * first real suspension), and leave the result `$Promise` (externref) on the
 * stack as the async function's return value. The function's result type must
 * already be rewritten to externref by the caller.
 */
export function emitAsyncFrameStateMachine(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): void {
  const rt = ensureAsyncDriveRuntime(ctx);
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const paramNames = fctx.params.map((p) => p.name);
  const paramTypes = fctx.params.map((p) => p.type);
  const info = buildAsyncFrameInfo(ctx, decl, plan, paramNames, paramTypes, promiseTypeIdx);
  const resumeFuncIdx = ensureAsyncResumeFunction(ctx, info, plan);
  if (resumeFuncIdx < 0) {
    reportError(ctx, decl, "internal: async-frame resume function unavailable (#2895 slice 1)");
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return;
  }

  // Fresh pending result promise → local.
  const resultPromiseLocal = allocLocal(fctx, "__async_resultp", { kind: "ref", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: resultPromiseLocal });

  // Build the $AsyncFrame: state=0, sent=null, mode=0, abrupt=null, error=null,
  // params (from this fn's wasm params), spills(default), result_promise.
  fctx.body.push({ op: "i32.const", value: 0 }); // state
  fctx.body.push({ op: "ref.null.extern" } as Instr); // sent
  fctx.body.push({ op: "i32.const", value: 0 }); // mode = MODE_NEXT
  fctx.body.push({ op: "ref.null.extern" } as Instr); // abrupt
  fctx.body.push({ op: "ref.null.extern" } as Instr); // error
  for (let i = 0; i < info.paramTypes.length; i++) {
    fctx.body.push({ op: "local.get", index: i });
  }
  for (let i = 0; i < info.spillNames.length; i++) {
    fctx.body.push(defaultSpillInstr(info.spillTypes[i]!));
  }
  fctx.body.push({ op: "local.get", index: resultPromiseLocal });
  fctx.body.push({ op: "struct.new", typeIdx: info.stateTypeIdx } as Instr);
  const frameLocal = allocLocal(fctx, "__async_frame", { kind: "ref", typeIdx: info.stateTypeIdx });
  fctx.body.push({ op: "local.set", index: frameLocal });

  // Kick the resume function once (runs the entry segment to the first real
  // suspension or to synchronous completion).
  fctx.body.push({ op: "local.get", index: frameLocal });
  fctx.body.push({ op: "call", funcIdx: resumeFuncIdx });

  // Return the result promise (externref).
  fctx.body.push({ op: "local.get", index: resultPromiseLocal });
  fctx.body.push({ op: "extern.convert_any" } as Instr);
  fctx.body.push({ op: "return" });
}
