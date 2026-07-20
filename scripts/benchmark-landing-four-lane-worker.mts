// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { porfforRendererOutputText } from "../src/ir/backend/porffor/compat.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";
import { landingBenchmarkProgram } from "./lib/landing-benchmark-corpus.mjs";
import {
  findExactFunction,
  normalizePinnedPorfforCForClang,
  porfforType,
  readExactSource,
  sha256Hex,
  wrapperForDirectRow,
  wrapperForJs2Row,
} from "./lib/porffor-direct-ab.mjs";
import { compileDirectPorfforProgram } from "./lib/porffor-direct-source-adapter.mjs";

type WorkerLane = "js2" | "plain";

interface WorkerArguments {
  readonly lane: WorkerLane;
  readonly programId: string;
  readonly outputDirectory: string;
}

const args = parseArguments(process.argv.slice(2));
await run(args);

function parseArguments(argv: readonly string[]): WorkerArguments {
  if (argv.length !== 6) throw new Error(usage());
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1]!;
    if (!["--lane", "--program", "--output"].includes(flag) || values.has(flag) || value.startsWith("--")) {
      throw new Error(usage());
    }
    values.set(flag, value);
  }
  const lane = values.get("--lane");
  if (lane !== "js2" && lane !== "plain") throw new Error(`unknown native lane ${String(lane)}`);
  return {
    lane,
    programId: values.get("--program")!,
    outputDirectory: resolve(values.get("--output")!),
  };
}

async function run(options: WorkerArguments): Promise<void> {
  const program = landingBenchmarkProgram(options.programId);
  const sourcePath = resolve(program.sourcePath);
  const source = readExactSource(sourcePath, program.sha256);
  if (source.bytes !== program.bytes) throw new Error(`${program.id} source byte count changed`);
  mkdirSync(options.outputDirectory, { recursive: true });

  const porfforRoot = resolve(process.env.JS2WASM_PORFFOR_ROOT || "vendor/Porffor");
  const renderedPath = join(options.outputDirectory, "rendered.c");
  const wrapperPath = join(options.outputDirectory, "wrapper.c");
  const lanePath = join(options.outputDirectory, "lane.c");
  const started = performance.now();

  if (options.lane === "plain") {
    const rawCliPath = join(options.outputDirectory, "porffor-cli-raw.c");
    const rawCliCommand = [join(porfforRoot, "porf"), "c", "--module", "-O1", source.path, rawCliPath];
    const rawCli = spawnSync(rawCliCommand[0], rawCliCommand.slice(1), {
      cwd: resolve("."),
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    if (rawCli.status !== 0) {
      throw new Error(`plain Porffor CLI failed: ${rawCli.stderr || String(rawCli.error ?? "")}`);
    }
    const rawCliBytes = statSync(rawCliPath).size;
    if (rawCliBytes !== program.plainPorfforCliCBytes) {
      throw new Error(
        `${program.id} plain Porffor CLI C size changed: expected ${program.plainPorfforCliCBytes}, received ${rawCliBytes}`,
      );
    }
    const direct = await compileDirectPorfforProgram({
      sourcePath: source.path,
      source: source.source,
      porfforRoot,
      rawOutputPath: join(options.outputDirectory, "porffor-adapter-render.c"),
      gc: true,
      functionName: program.functionName,
      sourceParameterName: program.sourceParameterName,
    });
    const wrapperC = wrapperForDirectRow({
      gc: true,
      functionSymbol: direct.functionSymbol,
      entrySymbol: direct.entrySymbol,
    });
    writeSupported({
      options,
      source,
      renderedC: direct.renderedC,
      wrapperC,
      functionSymbol: direct.functionSymbol,
      valueAbi: "boxed-jsval",
      compilePhasesMs: direct.compilePhasesMs,
      commandProvenance: {
        frontend: "pinned-plain-porffor",
        directPorfforArgumentModel: direct.commandModel,
        exactCliCommand: rawCliCommand,
        exactCliArtifact: {
          path: basename(rawCliPath),
          bytes: rawCliBytes,
          sha256: sha256Hex(readFileSync(rawCliPath)),
        },
        compatibilityNormalizations: direct.compatibilityNormalizations,
        generatedAccesses:
          "untouched CLI C is retained; the link adapter suppresses only main before render, preserves generated accesses, and changes only the disclosed LP64 printf compatibility cast",
      },
      renderedPath,
      wrapperPath,
      lanePath,
      totalWorkerWallMs: performance.now() - started,
    });
    return;
  }

  const sourceStart = performance.now();
  const compiled = await compile(source.source, {
    target: "linear",
    allocator: "analysis-stack",
    fileName: source.path,
  });
  const sourceToLinearMs = performance.now() - sourceStart;
  const report = getLastLinearIrReport();
  const exactFunctionSelected = report?.compiled.includes(program.functionName) === true;
  if (!compiled.success || !report || !exactFunctionSelected) {
    const rejection = report?.rejected.find((candidate) => candidate.func === program.functionName);
    const evidence = [
      ...(report?.rejected.map(
        (candidate) => `${candidate.func}:${candidate.reason}${candidate.detail ? `:${candidate.detail}` : ""}`,
      ) ?? []),
      ...compiled.errors.map((error) => `${error.severity}:${error.message}`),
    ];
    writeFileSync(
      join(options.outputDirectory, "worker.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          lane: options.lane,
          programId: program.id,
          source: { path: program.sourcePath, sha256: source.sha256, bytes: source.bytes },
          status: "unsupported",
          diagnostic: {
            phase: rejection?.reason.startsWith("select:") ? "js2-linear-ir-selection" : "js2-linear-ir-build",
            code: rejection?.reason ?? (report ? "run-not-selected" : "linear-report-missing"),
            message:
              rejection?.detail ??
              `the exact exported ${program.functionName} function did not reach the shared LinearMemoryPlan`,
            evidence: evidence.length > 0 ? evidence : ["no source-derived IR function was selected"],
            followUpIssue: followUpForNativeBlock(rejection?.reason, evidence),
          },
          compilePhasesMs: { js2SourceToLinearMs: sourceToLinearMs },
          compilerResourceUsage: compilerResourceUsage(),
          commandProvenance: {
            frontend: "js2-exact-source",
            js2CompileOptions: {
              target: "linear",
              allocator: "analysis-stack",
              fileName: source.path,
            },
            compiledFunctions: report?.compiled ?? [],
            rejectedFunctions: report?.rejected ?? [],
            compileSuccess: compiled.success,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const loweringStart = performance.now();
  let input: ReturnType<typeof lowerIrModuleToPorffor>;
  try {
    input = lowerIrModuleToPorffor(report.irModule, {
      memoryPlan: report.memoryPlan,
      prefs: { gc: false },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const jsBitwise = /does not support binary op 'js\.bit(?:and|or|xor)'/.test(message);
    writeFileSync(
      join(options.outputDirectory, "worker.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          lane: options.lane,
          programId: program.id,
          source: { path: program.sourcePath, sha256: source.sha256, bytes: source.bytes },
          status: "unsupported",
          diagnostic: {
            phase: "js2-porffor-legality",
            code: jsBitwise ? "typed-composite-bitwise-not-lowered" : "porffor-backend-legality-failed",
            message,
            evidence: [
              `compiled functions: ${JSON.stringify(report.compiled)}`,
              "report.irModule and report.memoryPlan were passed directly to lowerIrModuleToPorffor",
            ],
            followUpIssue: jsBitwise ? 3499 : null,
          },
          compilePhasesMs: {
            js2SourceToLinearMs: sourceToLinearMs,
            js2IrToPorfforFailedAfterMs: performance.now() - loweringStart,
          },
          compilerResourceUsage: compilerResourceUsage(),
          commandProvenance: {
            frontend: "js2-exact-source",
            js2CompileOptions: {
              target: "linear",
              allocator: "analysis-stack",
              fileName: source.path,
            },
            memoryPlan: report.memoryPlan,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const loweringMs = performance.now() - loweringStart;
  const functionRecord = findExactFunction(input, program.functionName);
  const f64 = porfforType("f64");
  if (
    input.entry !== null ||
    input.prefs.gc !== false ||
    functionRecord.params.length !== 1 ||
    functionRecord.params[0]?.type !== f64 ||
    functionRecord.retType !== f64
  ) {
    throw new Error(`${program.id} JS2 Porffor boundary is not raw f64 -> f64`);
  }

  const loadStart = performance.now();
  const porffor = await loadOptionalPorffor({ root: porfforRoot });
  const loadMs = performance.now() - loadStart;
  const renderStart = performance.now();
  const renderedC = normalizePinnedPorfforCForClang(porfforRendererOutputText(porffor.render(input)), porffor.commit);
  const renderMs = performance.now() - renderStart;
  if (/(?:^|\n)int main\s*\(/.test(renderedC)) throw new Error("JS2 Porffor route unexpectedly rendered main");
  const functionSymbol = `p${functionRecord.index}_${functionRecord.name}`;
  writeSupported({
    options,
    source,
    renderedC,
    wrapperC: wrapperForJs2Row(functionSymbol),
    functionSymbol,
    valueAbi: "raw-f64",
    compilePhasesMs: {
      js2SourceToLinearMs: sourceToLinearMs,
      js2IrToPorfforMs: loweringMs,
      porfforLoadMs: loadMs,
      porfforRenderMs: renderMs,
    },
    commandProvenance: {
      frontend: "js2-exact-source",
      js2CompileOptions: { target: "linear", allocator: "analysis-stack", fileName: source.path },
      telemetry:
        "getLastLinearIrReport captured immediately; report.irModule and report.memoryPlan passed without replanning",
      memoryPlan: report.memoryPlan,
      compatibilityNormalizations: ["single pinned LP64 i64 printf vararg cast"],
    },
    renderedPath,
    wrapperPath,
    lanePath,
    totalWorkerWallMs: performance.now() - started,
  });
}

function writeSupported(context: {
  readonly options: WorkerArguments;
  readonly source: ReturnType<typeof readExactSource>;
  readonly renderedC: string;
  readonly wrapperC: string;
  readonly functionSymbol: string;
  readonly valueAbi: "boxed-jsval" | "raw-f64";
  readonly compilePhasesMs: Readonly<Record<string, number>>;
  readonly commandProvenance: Readonly<Record<string, unknown>>;
  readonly renderedPath: string;
  readonly wrapperPath: string;
  readonly lanePath: string;
  readonly totalWorkerWallMs: number;
}): void {
  const laneC = `${context.renderedC}${context.wrapperC}`;
  writeFileSync(context.renderedPath, context.renderedC);
  writeFileSync(context.wrapperPath, context.wrapperC);
  writeFileSync(context.lanePath, laneC);
  writeFileSync(
    join(context.options.outputDirectory, "worker.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        lane: context.options.lane,
        programId: context.options.programId,
        source: {
          path: context.source.path,
          sha256: context.source.sha256,
          bytes: context.source.bytes,
        },
        status: "supported",
        function: { name: "run", symbol: context.functionSymbol, valueAbi: context.valueAbi },
        compilePhasesMs: context.compilePhasesMs,
        totalWorkerWallMs: context.totalWorkerWallMs,
        compilerResourceUsage: compilerResourceUsage(),
        artifacts: {
          renderedC: basename(context.renderedPath),
          wrapperC: basename(context.wrapperPath),
          laneC: basename(context.lanePath),
          renderedCBytes: Buffer.byteLength(context.renderedC),
          wrapperBytes: Buffer.byteLength(context.wrapperC),
          combinedCBytes: Buffer.byteLength(laneC),
          renderedCSha256: sha256Hex(context.renderedC),
          combinedCSha256: sha256Hex(laneC),
        },
        commandProvenance: context.commandProvenance,
      },
      null,
      2,
    )}\n`,
  );
}

function compilerResourceUsage(): Readonly<Record<string, unknown>> {
  const usage = process.resourceUsage();
  return {
    userCpuMicros: usage.userCPUTime,
    systemCpuMicros: usage.systemCPUTime,
    peakRss: usage.maxRSS,
    peakRssUnit: process.platform === "darwin" ? "bytes" : "kilobytes",
  };
}

function followUpForNativeBlock(reason: string | undefined, evidence: readonly string[]): number | null {
  if (reason === "select:return-type-not-resolvable") return 3497;
  if (reason === "select:call-graph-closure") return 3500;
  const joined = evidence.join("\n");
  if (/empty array literal needs a vec-typed hint/.test(joined)) return 3501;
  if (/compound assign to non-f64 slot|\.charAt\(\)|\.charCodeAt\(\)/.test(joined)) return 3502;
  return null;
}

function usage(): string {
  return "usage: benchmark-landing-four-lane-worker.mts --lane <js2|plain> --program <id> --output <dir>";
}
