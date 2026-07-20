// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import {
  PORFFOR_KIND_NAMES,
  porfforRendererOutputText,
  type PorfforNode,
  type PorfforRendererInput,
} from "../src/ir/backend/porffor/compat.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import {
  IrFunctionBuilder,
  irVal,
  lowerIrFunctionBody,
  verifyIrBackendLegality,
  wasmValueTypeConverter,
  type IrBinop,
  type IrFunction,
  type IrLowerResolver,
  type IrModule,
  type IrType,
} from "../src/ir/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const porfforRoot = process.env.JS2WASM_PORFFOR_ROOT ?? join(here, "../vendor/Porffor");
const hasOptionalPorffor = existsSync(join(porfforRoot, "compiler/ir.js"));
const nativeRequired = process.env.PORFFOR_NATIVE_REQUIRED === "1";
const cCompiler = findCCompiler();

const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const U32 = { kind: "val", val: { kind: "i32" }, signed: false } as const;
const BITWISE_OPS = ["js.bitand", "js.bitor", "js.bitxor", "js.shl", "js.shr_s", "js.shr_u"] as const;

function scalarFunction(
  name: string,
  op: (typeof BITWISE_OPS)[number],
  leftType: IrType = F64,
  rightType: IrType = F64,
  resultType: IrType = F64,
): IrFunction {
  const builder = new IrFunctionBuilder(name, [resultType], true);
  const left = builder.addParam("left", leftType);
  const right = builder.addParam("right", rightType);
  builder.openBlock();
  const result = builder.emitBinary(op, left, right, resultType);
  builder.terminate({ kind: "return", values: [result] });
  return builder.finish();
}

function narrowedChainFunction(): IrFunction {
  const builder = new IrFunctionBuilder("narrowedChain", [I32], true);
  const left = builder.addParam("left", I32);
  const right = builder.addParam("right", I32);
  const shift = builder.addParam("shift", I32);
  builder.openBlock();
  const xor = builder.emitBinary("js.bitxor", left, right, I32);
  const result = builder.emitBinary("js.shl", xor, shift, I32);
  builder.terminate({ kind: "return", values: [result] });
  return builder.finish();
}

function unsignedNarrowedChainFunction(): IrFunction {
  const builder = new IrFunctionBuilder("unsignedNarrowedChain", [I32], true);
  const value = builder.addParam("value", F64);
  const shift = builder.addParam("shift", I32);
  const mask = builder.addParam("mask", I32);
  builder.openBlock();
  const shifted = builder.emitBinary("js.shr_u", value, shift, U32);
  const result = builder.emitBinary("js.bitand", shifted, mask, I32);
  builder.terminate({ kind: "return", values: [result] });
  return builder.finish();
}

function proofModule(): IrModule {
  return {
    functions: [
      ...BITWISE_OPS.map((op) => scalarFunction(op.slice(3).replace(".", "_"), op)),
      scalarFunction("mixedF64I32", "js.bitand", F64, I32),
      scalarFunction("mixedI32F64", "js.bitor", I32, F64),
      narrowedChainFunction(),
      unsignedNarrowedChainFunction(),
    ],
  };
}

function resolver(): IrLowerResolver {
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: () => 0,
  };
}

describe("#3499 backend-neutral typed bitwise composites", () => {
  it("admits all JS bitwise variants for Porffor while preserving bytecode legality", () => {
    for (const func of proofModule().functions) {
      expect(verifyIrBackendLegality(func, "porffor"), func.name).toEqual([]);
    }

    const bytecodeErrors = verifyIrBackendLegality(scalarFunction("bytecodeBoundary", "js.bitor"), "bytecode");
    expect(bytecodeErrors.some((error) => /does not support binary op 'js\.bitor'/.test(error.message))).toBe(true);
  });

  it("keeps the WasmGC and linear instruction streams byte-for-byte aligned", () => {
    const func = scalarFunction("stableWasm", "js.bitor");
    const lower = (backend: "wasmgc" | "linear") =>
      lowerIrFunctionBody(
        func,
        resolver(),
        backend === "wasmgc" ? new WasmGcEmitter() : new LinearEmitter(),
        wasmValueTypeConverter(backend, resolver(), func.name),
      );
    const wasmGc = lower("wasmgc");
    const linear = lower("linear");

    expect(linear).toStrictEqual(wasmGc);
    expect(wasmGc.locals).toEqual([
      { name: "$js_bitwise_tmp", slots: [{ kind: "f64" }] },
      { name: "$js_bitwise_rhs", slots: [{ kind: "f64" }] },
    ]);
    expect(wasmGc.body.map((instr) => instr.op)).toEqual([
      "local.get",
      "local.get",
      "local.set",
      "f64.trunc",
      "local.tee",
      "local.get",
      "f64.const",
      "f64.div",
      "f64.floor",
      "f64.const",
      "f64.mul",
      "f64.sub",
      "i32.trunc_sat_f64_u",
      "local.get",
      "f64.trunc",
      "local.tee",
      "local.get",
      "f64.const",
      "f64.div",
      "f64.floor",
      "f64.const",
      "f64.mul",
      "f64.sub",
      "i32.trunc_sat_f64_u",
      "i32.or",
      "f64.convert_i32_s",
      "return",
    ]);
  });

  it("maps ToInt32, masked shifts, and result signedness without RawC", () => {
    const input = lowerIrModuleToPorffor(proofModule(), { prefs: { gc: false } });
    const nodes = input.funcs.flatMap((func) => collectNodes(func?.body ?? []));
    const binaryOps = nodes.filter((node) => nodeName(node) === "Bin").map((node) => node[3]);
    const kinds = nodes.map(nodeName);

    expect(binaryOps).toEqual(expect.arrayContaining(["&", "|", "^", "<<", ">>"]));
    expect(kinds).toContain("Convert");
    expect(kinds).toContain("Un");
    expect(kinds).not.toContain("RawC");

    const shifts = nodes.filter((node) => nodeName(node) === "Bin" && (node[3] === "<<" || node[3] === ">>"));
    expect(shifts.length).toBeGreaterThanOrEqual(3);
    for (const shift of shifts) {
      const count = shift[5] as PorfforNode;
      expect(nodeName(count)).toBe("Bin");
      expect(count[3]).toBe("&");
      expect(collectNodes(count).some((node) => nodeName(node) === "Const" && node[3] === 31)).toBe(true);
    }

    const unsigned = input.funcs.find((func) => func?.name === "shr_u");
    if (!unsigned) throw new Error("missing shr_u proof function");
    const returnValue = collectNodes(unsigned.body).find((node) => nodeName(node) === "Return")?.[3];
    expect(collectNodes(returnValue).some((node) => nodeName(node) === "Convert")).toBe(true);
  });

  const nativeIt = hasOptionalPorffor && cCompiler ? it : nativeRequired ? it : it.skip;
  nativeIt(
    "matches JavaScript for coercion edges and masked shifts under ASan/UBSan",
    async () => {
      if (!hasOptionalPorffor) throw new Error(`PORFFOR_NATIVE_REQUIRED=1 but ${porfforRoot} is not initialized`);
      if (!cCompiler) throw new Error("PORFFOR_NATIVE_REQUIRED=1 but no C compiler is available");

      const input = lowerIrModuleToPorffor(proofModule(), { prefs: { gc: false } });
      const porffor = await loadOptionalPorffor({ root: porfforRoot });
      const rendered = normalizePinnedPorfforC(porfforRendererOutputText(porffor.render(input)));
      const actual = compileAndRunSanitizedC(cCompiler, rendered, input);
      const expected = [
        4_294_967_297.75 & -3.5,
        -2_147_483_649.25 | 1.5,
        Number.POSITIVE_INFINITY ^ Number.NaN,
        -1 << 31,
        -2_147_483_648 >> 63,
        -1 >>> 0,
        4_294_967_297.75 & -3,
        -2 | 4_294_967_297.5,
        (0x4000_0001 ^ -7) << 34,
        (-1 >>> 63) & 0x7fff_ffff,
      ];

      expect(actual).toStrictEqual(expected);
    },
    120_000,
  );
});

function collectNodes(value: unknown, out: PorfforNode[] = []): PorfforNode[] {
  if (!Array.isArray(value)) return out;
  if (value.length === 6 && typeof value[0] === "number" && PORFFOR_KIND_NAMES[value[0]]) {
    const node = value as unknown as PorfforNode;
    out.push(node);
    collectNodes(node[3], out);
    collectNodes(node[4], out);
    collectNodes(node[5], out);
    return out;
  }
  for (const item of value) collectNodes(item, out);
  return out;
}

function nodeName(node: PorfforNode): string {
  return PORFFOR_KIND_NAMES[node[0]]!;
}

function findCCompiler(): string | null {
  for (const candidate of [process.env.CC, "clang", "cc"].filter((value): value is string => !!value)) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}

function normalizePinnedPorfforC(rendered: string): string {
  const incompatible = 'snprintf(buf, sizeof buf, "%lld", (i64)d)';
  const portable = 'snprintf(buf, sizeof buf, "%lld", (long long)(i64)d)';
  const occurrences = rendered.split(incompatible).length - 1;
  if (occurrences !== 1) {
    throw new Error(`pinned Porffor i64 printf compatibility site count changed: expected 1, received ${occurrences}`);
  }
  return rendered.replace(incompatible, portable);
}

function compileAndRunSanitizedC(compiler: string, rendered: string, input: PorfforRendererInput): number[] {
  const symbol = (name: string): string => {
    const func = input.funcs.find((candidate) => candidate?.name === name);
    if (!func) throw new Error(`missing Porffor function ${name}`);
    return `p${func.index}_${func.name}`;
  };
  const harness = `
int main(int argc, char** argv) {
  porf_init(argc, argv);
  porf_data_init();
  printf("%.17g\\n", ${symbol("bitand")}(4294967297.75, -3.5));
  printf("%.17g\\n", ${symbol("bitor")}(-2147483649.25, 1.5));
  printf("%.17g\\n", ${symbol("bitxor")}(INFINITY, NAN));
  printf("%.17g\\n", ${symbol("shl")}(-1.0, 31.0));
  printf("%.17g\\n", ${symbol("shr_s")}(-2147483648.0, 63.0));
  printf("%.17g\\n", ${symbol("shr_u")}(-1.0, 0.0));
  printf("%.17g\\n", ${symbol("mixedF64I32")}(4294967297.75, -3));
  printf("%.17g\\n", ${symbol("mixedI32F64")}(-2, 4294967297.5));
  printf("%lld\\n", (long long)${symbol("narrowedChain")}(0x40000001, -7, 34));
  printf("%lld\\n", (long long)${symbol("unsignedNarrowedChain")}(-1.0, 63, 0x7fffffff));
  return 0;
}
`;
  const directory = mkdtempSync(join(tmpdir(), "js2-porffor-3499-"));
  const sourcePath = join(directory, "bitwise.c");
  const binaryPath = join(directory, "bitwise");
  try {
    writeFileSync(sourcePath, rendered + harness);
    const result = spawnSync(
      compiler,
      [
        "-std=gnu11",
        "-O1",
        "-g",
        "-Werror",
        "-Wno-unused-function",
        "-fsanitize=address,undefined",
        "-fno-omit-frame-pointer",
        sourcePath,
        "-lm",
        "-o",
        binaryPath,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, `C compiler failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    const stdout = execFileSync(binaryPath, {
      encoding: "utf8",
      env: {
        ...process.env,
        ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1:abort_on_error=1",
        UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
      },
    });
    return stdout.trim().split("\n").map(Number);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
