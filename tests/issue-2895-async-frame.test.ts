// #2895 PATH B (slice 1 — foundation) — the host-free async-frame substrate.
//
// Validates the inert frame-layout layer: the `isAsyncDriveActive` gate and the
// per-async-function `$AsyncFrame` state-struct shape built by
// `buildAsyncFrameInfo`. The resume-function emitter, await-suspend lowering,
// and call-site wiring land in following slices; this file pins the ABI the
// emitter builds against.
import { describe, it, expect } from "vitest";
import * as ts from "typescript";
// Import the top compiler entry first so the codegen module graph initializes in
// the correct order (the regexp-standalone → string-ops → coercion-engine init
// cycle is otherwise tripped by loading the barrel cold).
import { compile } from "../src/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/index.js";
import { getOrRegisterPromiseType } from "../src/codegen/async-scheduler.js";
import { analyzeAsyncBody } from "../src/codegen/async-cps.js";
import { isAsyncDriveActive, buildAsyncFrameInfo } from "../src/codegen/async-frame.js";
import {
  PARAM_FIELD_OFFSET,
  STATE_FIELD,
  SENT_FIELD,
  MODE_FIELD,
  ABRUPT_FIELD,
  ERROR_FIELD,
} from "../src/codegen/frame-core.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import type { ValType, StructTypeDef } from "../src/ir/types.js";

function makeDummyChecker(): ts.TypeChecker {
  return {} as unknown as ts.TypeChecker;
}

/** First top-level async function declaration in `src`. */
function firstAsyncFn(src: string): ts.FunctionDeclaration {
  const sf = ts.createSourceFile("_t.ts", src, ts.ScriptTarget.Latest, true);
  const fn = sf.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("test setup: no function declaration");
  return fn;
}

/** A real bound Program+checker over a single in-memory source file. */
function programChecker(src: string): { fn: ts.FunctionDeclaration; checker: ts.TypeChecker } {
  const fileName = "/_t.ts";
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? src : undefined),
  };
  const program = ts.createProgram([fileName], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const root = program.getSourceFile(fileName)!;
  const fn = root.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("test setup: no function declaration");
  return { fn, checker };
}

function makeCtx(options?: { standalone?: boolean; wasi?: boolean }, checker?: ts.TypeChecker): CodegenContext {
  return createCodegenContext(createEmptyModule(), checker ?? makeDummyChecker(), options);
}

describe("#2895 PATH B foundation — isAsyncDriveActive", () => {
  it("is active for --target standalone", () => {
    expect(isAsyncDriveActive(makeCtx({ standalone: true }))).toBe(true);
  });
  it("is active for --target wasi", () => {
    expect(isAsyncDriveActive(makeCtx({ wasi: true }))).toBe(true);
  });
  it("is inactive for the default JS-host target", () => {
    expect(isAsyncDriveActive(makeCtx())).toBe(false);
  });
});

describe("#2895 PATH B foundation — $AsyncFrame state struct", () => {
  it("registers the fixed frame ABI fields, a param field, and a trailing result promise", () => {
    const ctx = makeCtx({ standalone: true });
    const promiseTypeIdx = getOrRegisterPromiseType(ctx);
    const fn = firstAsyncFn(`async function f(a: number) { await p(); return a; }`);
    const plan = analyzeAsyncBody(ctx, fn);

    const info = buildAsyncFrameInfo(ctx, fn, plan, ["a"], [{ kind: "f64" }], promiseTypeIdx);

    // Leading frame ABI (frame-core constants), all at their canonical offsets.
    const struct = ctx.mod.types[info.stateTypeIdx] as StructTypeDef;
    expect(struct.kind).toBe("struct");
    const f = struct.fields;
    expect(f[STATE_FIELD]).toMatchObject({ name: "state", type: { kind: "i32" } });
    expect(f[SENT_FIELD]).toMatchObject({ name: "sent", type: { kind: "externref" } });
    expect(f[MODE_FIELD]).toMatchObject({ name: "mode", type: { kind: "i32" } });
    expect(f[ABRUPT_FIELD]).toMatchObject({ name: "abrupt", type: { kind: "externref" } });
    expect(f[ERROR_FIELD]).toMatchObject({ name: "error", type: { kind: "externref" } });

    // Param captured at PARAM_FIELD_OFFSET with its natural ValType.
    expect(info.paramFieldOffset).toBe(PARAM_FIELD_OFFSET);
    expect(f[PARAM_FIELD_OFFSET]).toMatchObject({ name: "param_a", type: { kind: "f64" } });

    // No body local is live across the await (only the param `a` is), so no spills.
    expect(info.spillNames).toEqual([]);
    expect(info.spillFieldOffset).toBe(PARAM_FIELD_OFFSET + 1);

    // Trailing result-promise field of type (ref $Promise).
    expect(info.resultPromiseFieldIdx).toBe(info.spillFieldOffset);
    const resultField = f[info.resultPromiseFieldIdx]!;
    expect(resultField.name).toBe("result_promise");
    expect(resultField.type).toMatchObject({ kind: "ref", typeIdx: promiseTypeIdx });

    expect(info.modeFieldIdx).toBe(MODE_FIELD);
    expect(info.promiseTypeIdx).toBe(promiseTypeIdx);
  });

  it("spills a body local live across the await, excluding params and the resume binding", () => {
    const { fn, checker } = programChecker(
      `async function f(a: number): Promise<number> {
         let keep: number = a + 1;
         const r = await p();
         return keep + r;
       }`,
    );
    const ctx = makeCtx({ standalone: true }, checker);
    const promiseTypeIdx = getOrRegisterPromiseType(ctx);
    const plan = analyzeAsyncBody(ctx, fn);

    const info = buildAsyncFrameInfo(ctx, fn, plan, ["a"], [{ kind: "f64" } as ValType], promiseTypeIdx);

    // `keep` is read after the await → spilled. `a` is a param (param field, not
    // a spill). `r` is the resume binding (delivered from SENT_FIELD) → not a spill.
    expect(info.spillNames).toContain("keep");
    expect(info.spillNames).not.toContain("a");
    expect(info.spillNames).not.toContain("r");

    // Each spill field sits at/after spillFieldOffset and is mutable.
    const struct = ctx.mod.types[info.stateTypeIdx] as StructTypeDef;
    const keepIdx = info.spillFieldOffset + info.spillNames.indexOf("keep");
    expect(struct.fields[keepIdx]!.name).toBe("spill_keep");
    expect(struct.fields[keepIdx]!.mutable).toBe(true);
  });
});

// ── PATH B slice 1b/1c: the live host-free async drive layer (validated on the
// native-`$Promise` carrier target — `--target wasi`, where the carrier gate is
// already on; the `--target standalone` re-widen is slice 1d). ────────────────

/** Compile a host-free async program and instantiate it (imports must be empty). */
async function instantiateWasi(src: string): Promise<WebAssembly.Exports> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // The drive layer is host-free: the module must request no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports;
}

describe("#2895 PATH B drive layer — host-free async frame suspension", () => {
  it("synchronously-settled await delivers the resolved value (FULFILLED fast path)", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function g(): Promise<number> { return 41; }
      async function f(): Promise<number> { const x = await g(); cap = x; return x + 1; }
      export function test(): number { f() as any; return cap; }
    `)) as { test: () => number };
    expect(ex.test()).toBe(41);
  });

  it("chained drive-lowered async fns thread the value through both frames", async () => {
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function g(): Promise<number> { return 41; }
      async function h(): Promise<number> { const a = await g(); return a + 1; }
      async function f(): Promise<number> { const x = await h(); cap = x; return x + 1; }
      export function test(): number { f() as any; return cap; }
    `)) as { test: () => number };
    expect(ex.test()).toBe(42); // g→41, h→42, f reads 42
  });

  it("GENUINELY-PENDING await suspends, then the microtask drain resumes the frame", async () => {
    // `Promise.resolve(1).then(cb)` is PENDING until the drain runs `cb` on a
    // microtask — the await must spill, register a reaction, and return; the
    // drain settles the awaited promise, fires the reaction, and resumes the
    // frame at the saved state with the delivered value. This is the case AG0's
    // one-level unwrap cannot serve.
    const ex = (await instantiateWasi(`
      let cap: number = 0;
      async function consumer(): Promise<void> {
        const x = await Promise.resolve(1).then((v: number) => v + 40);
        cap = x;
      }
      export function kick(): number { consumer() as any; return cap; }
      export function getCap(): number { return cap; }
    `)) as { kick: () => number; getCap: () => number; __drain_microtasks: () => void };
    expect(ex.kick()).toBe(0); // suspended: continuation has not run yet
    ex.__drain_microtasks(); // run the pending `.then` + the resumed continuation
    expect(ex.getCap()).toBe(41); // 1 + 40, delivered on resume
  });
});
