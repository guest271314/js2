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
  ERROR_FIELD,
  sanitizeTypeName,
  storeSpills,
  setStateI32FromConst,
  defaultSpillInstr,
} from "./frame-core.js";
import type { AsyncCpsPlan } from "./async-cps.js";
import { splitBodyAtAwait } from "./async-cps.js";
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

// ── PATH B slice 1b: resume function + step adapters + call-site shim ─────────

/**
 * Build (idempotently) the host-free async **resume function**
 * `__async_resume_f<name>(frame) -> void` and its two microtask **step
 * adapters** for one async function. Returns the resume funcIdx.
 *
 * For the slice-1 single-await canonical shape (`splitBodyAtAwait`) the resume
 * function is a **2-state** machine driven by `frame.STATE_FIELD`:
 *   - state 0 (entry): run the synchronous prefix, evaluate the awaited operand
 *     and assimilate it to a `$Promise`. If it is already FULFILLED, deliver its
 *     value into `SENT_FIELD` and fall through into the continuation (fast path).
 *     If still PENDING, `storeSpills`, set STATE=1, register a reaction
 *     (`__async_step_fulfill_f<name>` / `__async_step_reject_f<name>` funcrefs +
 *     this frame as caps) on the awaited promise's callback list, and `return`
 *     (suspend). A non-`$Promise` operand is delivered straight through.
 *   - state 1 (continuation): bind the resume value from `SENT_FIELD`, then run
 *     the suffix. `return v` settles `frame.result_promise` (the
 *     `asyncDriveReturn` hook); a fall-through end settles it with undefined.
 *
 * Uses the generator slot-reservation discipline (#2079/#1677/#1809): the resume
 * function and both step adapters reserve their funcIdx slots with placeholder
 * bodies BEFORE the resume body is emitted, because `compileStatement` on the
 * prefix/suffix can lazily append helper functions to `ctx.mod.functions` — a
 * stale capture would otherwise repoint every baked `call`/`ref.func`.
 */
export function ensureAsyncResumeFunction(ctx: CodegenContext, info: AsyncFrameInfo, plan: AsyncCpsPlan): number {
  if (info.resumeFuncIdx !== undefined) return info.resumeFuncIdx;

  const split = splitBodyAtAwait(info.decl, plan);
  if (split === null) {
    reportError(ctx, info.decl, "internal: async-frame resume built on an unsupported body shape (#2895 slice 1)");
    info.resumeFuncIdx = -1;
    return -1;
  }

  const rt = ensureAsyncDriveRuntime(ctx);
  const frameRef: ValType = { kind: "ref", typeIdx: info.stateTypeIdx };
  const stem = sanitizeTypeName(info.functionName);

  // Reserve slots: resume fn, then the two step adapters. The microtask wrapper
  // ABI is (caps externref, value externref) -> externref (result dropped).
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
  // Load spills from the frame into locals (overwritten by the prefix on first
  // entry; restored from the frame on resume).
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

  // Resume binding (`const x = await P`) — declared up-front so the continuation
  // and (harmlessly) the entry segment share the slot.
  let resumeBindingLocal: number | undefined;
  let resumeBindingType: ValType | undefined;
  if (split.resumeBinding) {
    resumeBindingType = split.resumeBinding.type
      ? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(split.resumeBinding.type))
      : { kind: "externref" };
    resumeBindingLocal = allocLocal(resumeFctx, split.resumeBinding.name, resumeBindingType);
  }

  // Compile the entry + continuation segments under this resume context (so late
  // imports shift THIS body). `liveBodies` guards the detached outer arrays.
  const savedFunc = ctx.currentFunc;
  ctx.currentFunc = resumeFctx;
  let entrySeg: Instr[];
  let contSeg: Instr[];
  try {
    entrySeg = buildEntrySegment(ctx, resumeFctx, info, split, rt, frameLocal);
    contSeg = buildContinuationSegment(
      ctx,
      resumeFctx,
      info,
      split,
      resultPromiseLocal,
      rt,
      frameLocal,
      resumeBindingLocal,
      resumeBindingType,
    );
  } finally {
    ctx.currentFunc = savedFunc;
  }

  // 2-state dispatch: state 0 runs the entry (which either suspends with
  // `return` or falls through delivering SENT); any other state skips straight
  // to the continuation. The entry's fall-through and the state!=0 path both
  // reach the continuation that follows the `if`.
  resumeFctx.body.push({ op: "local.get", index: frameLocal });
  resumeFctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD });
  resumeFctx.body.push({ op: "i32.eqz" });
  resumeFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: entrySeg } as Instr);
  for (const instr of contSeg) resumeFctx.body.push(instr);

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
 * Entry segment (state 0): synchronous prefix → assimilate awaited operand → on
 * FULFILLED deliver value to SENT and fall through; on PENDING register the
 * reaction and `return` (suspend); a non-`$Promise` operand is delivered
 * straight through. Built into a detached `Instr[]`.
 */
function buildEntrySegment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: AsyncFrameInfo,
  split: ReturnType<typeof splitBodyAtAwait> & object,
  rt: AsyncDriveRuntime,
  frameLocal: number,
): Instr[] {
  const promiseTypeIdx = info.promiseTypeIdx;
  const saved = fctx.body;
  ctx.liveBodies.add(saved);
  const seg: Instr[] = [];
  fctx.body = seg;
  try {
    for (const stmt of split.prefix) compileStatement(ctx, fctx, stmt);

    // Awaited operand → externref.
    const awaitedType = compileExpression(ctx, fctx, split.awaitedExpr);
    if (awaitedType !== null && awaitedType !== undefined) {
      coerceType(ctx, fctx, awaitedType as ValType, { kind: "externref" });
    } else {
      seg.push({ op: "ref.null.extern" } as Instr);
    }
    const awaitedLocal = allocLocal(fctx, "__async_awaited", { kind: "externref" });
    seg.push({ op: "local.set", index: awaitedLocal });

    // Cast the awaited `$Promise` into a single typed local and reuse it for
    // every field access / reaction receiver. A repeated `local.get <externref>;
    // any.convert_extern; ref.cast` pattern confuses the stack-balance
    // type-repair pass (it re-infers the value and splices a bogus
    // `ref.cast_null; any.convert_extern` "fixup"), so we narrow once here.
    const pLocal = allocLocal(fctx, "__async_p", { kind: "ref", typeIdx: promiseTypeIdx });

    // frame.SENT = pLocal.value — minted fresh per use (FULFILLED + REJECTED
    // arms) so no `Instr[]` is aliased into two branch slots (a later
    // type/funcIdx-shift pass would double-mutate a shared array; memory
    // `reference_shared_instr_object_dce_double_remap`).
    const deliverFromP = (): Instr[] => [
      { op: "local.get", index: frameLocal },
      { op: "local.get", index: pLocal },
      { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 } as Instr,
      { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD } as Instr,
    ];
    const deliverPlain: Instr[] = [
      { op: "local.get", index: frameLocal },
      { op: "local.get", index: awaitedLocal },
      { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD } as Instr,
    ];

    // Suspend arm: storeSpills + STATE=1 + register reaction + return.
    const suspend: Instr[] = [
      ...storeSpills(info, fctx, frameLocal),
      ...setStateI32FromConst(info, frameLocal, STATE_FIELD, 1),
      // promise.callbacks = $PromiseCallback{stepFulfill, frame, stepReject, frame, promise.callbacks}
      { op: "local.get", index: pLocal }, // receiver for struct.set callbacks
      { op: "ref.func", funcIdx: info.stepFulfillFuncIdx! } as Instr,
      { op: "local.get", index: frameLocal },
      { op: "extern.convert_any" } as Instr,
      { op: "ref.func", funcIdx: info.stepRejectFuncIdx! } as Instr,
      { op: "local.get", index: frameLocal },
      { op: "extern.convert_any" } as Instr,
      { op: "local.get", index: pLocal },
      { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 2 } as Instr, // current callbacks (next)
      { op: "struct.new", typeIdx: rt.callbackTypeIdx } as Instr,
      { op: "extern.convert_any" } as Instr,
      { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 2 } as Instr,
      { op: "return" },
    ];

    // PENDING-or-rejected discrimination inside the "is a promise" arm.
    const pendingOrRejected: Instr[] = [
      { op: "local.get", index: pLocal },
      { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 } as Instr,
      { op: "i32.const", value: PROMISE_STATE_REJECTED },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: deliverFromP(), // rejected-now: deliver reason as value (slice-1)
        else: suspend, // genuinely pending: suspend
      } as Instr,
    ];

    // is it a $Promise?
    seg.push(
      { op: "local.get", index: awaitedLocal },
      { op: "any.convert_extern" } as Instr,
      { op: "ref.test", typeIdx: promiseTypeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // narrow once: pLocal = (ref $Promise) awaitedLocal
          { op: "local.get", index: awaitedLocal },
          { op: "any.convert_extern" } as Instr,
          { op: "ref.cast", typeIdx: promiseTypeIdx } as Instr,
          { op: "local.set", index: pLocal },
          // state == FULFILLED ?
          { op: "local.get", index: pLocal },
          { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 } as Instr,
          { op: "i32.const", value: PROMISE_STATE_FULFILLED },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: deliverFromP(), // fulfilled: deliver value, fall through
            else: pendingOrRejected,
          } as Instr,
        ],
        else: deliverPlain, // non-promise: deliver straight through
      } as Instr,
    );
  } finally {
    fctx.body = saved;
    ctx.liveBodies.delete(saved);
  }
  return seg;
}

/**
 * Continuation segment (state 1): bind the resume value from `SENT_FIELD`, run
 * the suffix (whose `return v` settles `result_promise` via the
 * `asyncDriveReturn` hook), then settle with undefined on fall-through.
 */
function buildContinuationSegment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: AsyncFrameInfo,
  split: ReturnType<typeof splitBodyAtAwait> & object,
  resultPromiseLocal: number,
  rt: AsyncDriveRuntime,
  frameLocal: number,
  resumeBindingLocal: number | undefined,
  resumeBindingType: ValType | undefined,
): Instr[] {
  const saved = fctx.body;
  ctx.liveBodies.add(saved);
  const seg: Instr[] = [];
  fctx.body = seg;
  try {
    // Bind `x = SENT` (coerced) for `const x = await P`.
    if (resumeBindingLocal !== undefined && resumeBindingType) {
      seg.push({ op: "local.get", index: frameLocal });
      seg.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD });
      coerceType(ctx, fctx, { kind: "externref" }, resumeBindingType);
      seg.push({ op: "local.set", index: resumeBindingLocal });
    }

    if (split.isReturnAwait) {
      // `return await P`: the resolved value IS the result. Settle with SENT.
      seg.push({ op: "local.get", index: resultPromiseLocal });
      seg.push({ op: "local.get", index: frameLocal });
      seg.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD });
      seg.push({ op: "call", funcIdx: rt.fulfillFuncIdx });
      seg.push({ op: "drop" });
      seg.push({ op: "return" });
    } else {
      for (const stmt of split.suffix) compileStatement(ctx, fctx, stmt);
      // Fall-through (no explicit return): settle result with undefined.
      seg.push({ op: "local.get", index: resultPromiseLocal });
      seg.push({ op: "ref.null.extern" } as Instr);
      seg.push({ op: "call", funcIdx: rt.fulfillFuncIdx });
      seg.push({ op: "drop" });
    }
  } finally {
    fctx.body = saved;
    ctx.liveBodies.delete(saved);
  }
  return seg;
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
