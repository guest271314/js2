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
// cycle is otherwise tripped by loading the barrel cold). Not otherwise used.
import "../src/index.js";
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
