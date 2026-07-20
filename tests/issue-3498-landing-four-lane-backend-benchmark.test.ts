// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { LANDING_BENCHMARK_PROGRAMS } from "../scripts/lib/landing-benchmark-corpus.mjs";
import {
  LANDING_FOUR_LANE_IDS,
  LANDING_FOUR_LANE_MEASURED_ROUNDS,
  LANDING_FOUR_LANE_WARMUP_ROUNDS,
  validateLandingFourLaneResult,
  verifyLandingBenchmarkCorpus,
  type LandingFourLaneResult,
} from "../scripts/lib/landing-four-lane-benchmark.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "js2-3498-"));
const coreOutput = join(temporaryRoot, "core");
const configuredOutput = process.env.LANDING_FOUR_LANE_TEST_OUTPUT;
const fullOutput = configuredOutput ? resolve(repoRoot, configuredOutput) : join(temporaryRoot, "full");
const toolchainsRequired = process.env.LANDING_FOUR_LANE_REQUIRED === "1";
const coreAvailable =
  existsSync(resolve(repoRoot, "node_modules/.bin/wasm-opt")) &&
  spawnSync("wasmtime", ["--version"], { cwd: repoRoot, stdio: "ignore" }).status === 0;
const nativeAvailable =
  coreAvailable &&
  existsSync(resolve(repoRoot, "vendor/Porffor/porf")) &&
  spawnSync(process.env.CC || "clang", ["--version"], { cwd: repoRoot, stdio: "ignore" }).status === 0;
const coreIt = coreAvailable || toolchainsRequired ? it : it.skip;
const nativeIt = nativeAvailable || toolchainsRequired ? it : it.skip;

let coreResult: LandingFourLaneResult | undefined;

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("#3498 landing four-lane backend benchmark", () => {
  it("pins and oracles the four exact landing source files without object-ops", async () => {
    expect(LANDING_BENCHMARK_PROGRAMS.map((program) => program.id)).toEqual([
      "fib",
      "fib-recursive",
      "array-sum",
      "string-hash",
    ]);
    const records = await verifyLandingBenchmarkCorpus(repoRoot);
    expect(records).toMatchObject([
      {
        id: "fib",
        bytes: 348,
        sha256: "910ab9ef86bf7ed4c6b7e55c0fe20d93b653dd8bfdb5d48de6ef906778943a73",
        fixedInputs: [0, 1, 5_000, 20_000_000],
        expectedFixedOutputs: [0, 1, -1_846_256_875, -1_821_818_939],
      },
      {
        id: "fib-recursive",
        bytes: 318,
        sha256: "abdd6f6e6c3308220df37f85e7a4c47dc07aba48f4862836dd669809ac53df24",
        fixedInputs: [0, 1, 10, 30],
        expectedFixedOutputs: [0, 1, 55, 832_040],
      },
      {
        id: "array-sum",
        bytes: 441,
        sha256: "61affa6e44688788cfdb50f5186078cb55c171f19df2bb104e2dcb9f331cd59c",
        fixedInputs: [0, 1, 2_000, 1_000_000],
        expectedFixedOutputs: [0, 0, 1_018_392, 511_492_320],
      },
      {
        id: "string-hash",
        bytes: 601,
        sha256: "66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c",
        fixedInputs: [0, 1, 100, 20_000],
        expectedFixedOutputs: [0, 96_500, 36_729_899, 862_771_296],
      },
    ]);
    for (const program of LANDING_BENCHMARK_PROGRAMS) {
      expect(program.sourcePath).toBe(`website/public/benchmarks/competitive/programs/${program.id}.js`);
      expect(program.id).not.toBe("object-ops");
    }
    expect(readFileSync(resolve(repoRoot, "scripts/generate-wasmtime-hot-runtime.mjs"), "utf8")).toContain(
      'from "./lib/landing-benchmark-corpus.mjs"',
    );
  });

  coreIt(
    "executes exact V8 and JS2-Wasm outputs for all four kernels",
    () => {
      if (!coreAvailable) throw new Error("LANDING_FOUR_LANE_REQUIRED=1 but Wasmtime/wasm-opt are unavailable");
      coreResult = runProbe(coreOutput, true);
      expect(coreResult.cells).toHaveLength(16);
      expect(coreResult.cells.map((cell) => `${cell.programId}:${cell.laneId}`)).toEqual(
        LANDING_BENCHMARK_PROGRAMS.flatMap((program) => LANDING_FOUR_LANE_IDS.map((lane) => `${program.id}:${lane}`)),
      );
      for (const program of coreResult.programs) {
        for (const laneId of ["v8-node-exact-source", "js2-wasmgc-wasmtime-cranelift"] as const) {
          const cell = coreResult.cells.find(
            (candidate) => candidate.programId === program.id && candidate.laneId === laneId,
          );
          expect(cell).toMatchObject({ status: "supported", sourceSha256: program.sha256, diagnostic: null });
          expect(cell?.validation?.actualOutputs).toEqual(program.expectedFixedOutputs);
        }
      }
    },
    60_000,
  );

  coreIt("rejects source substitution, omission, output drift, skipped success, and invalid timing", () => {
    if (!coreAvailable) throw new Error("LANDING_FOUR_LANE_REQUIRED=1 but Wasmtime/wasm-opt are unavailable");
    coreResult ??= runProbe(coreOutput, true);
    validateLandingFourLaneResult(coreResult);

    const substituted = clone(coreResult);
    substituted.cells[0]!.sourceSha256 = "0".repeat(64);
    expect(() => validateLandingFourLaneResult(substituted)).toThrow(/substituted/);

    const omitted = clone(coreResult);
    omitted.cells.pop();
    expect(() => validateLandingFourLaneResult(omitted)).toThrow(/16 support cells/);

    const wrongOutput = clone(coreResult);
    wrongOutput.cells[0]!.validation!.actualOutputs[0] = 123;
    expect(() => validateLandingFourLaneResult(wrongOutput)).toThrow(/actual outputs mismatch/);

    const skipped = clone(coreResult);
    skipped.cells[0]!.provenance = { outcome: "skipped success" };
    expect(() => validateLandingFourLaneResult(skipped)).toThrow(/skipped is not/);

    const zeroTiming = clone(coreResult);
    zeroTiming.cells[0]!.measurements.build = {
      reason: null,
      samples: [
        {
          phase: "measured",
          round: 0,
          order: 0,
          wallNs: 0,
          cpuNs: 0,
          peakRssBytes: 0,
          validatedOutput: null,
          outputObservation: null,
          commands: [["false-success"]],
        },
      ],
    };
    expect(() => validateLandingFourLaneResult(zeroTiming)).toThrow(/wallNs invalid/);

    const nullBenchmark = clone(coreResult);
    nullBenchmark.capture = {
      kind: "benchmark",
      canonical: false,
      warmupRounds: LANDING_FOUR_LANE_WARMUP_ROUNDS,
      measuredRounds: LANDING_FOUR_LANE_MEASURED_ROUNDS,
    };
    expect(() => validateLandingFourLaneResult(nullBenchmark)).toThrow(
      /executable benchmark cell must carry timing samples/,
    );

    const completeBenchmark = clone(coreResult);
    completeBenchmark.capture = nullBenchmark.capture;
    const executableCells = completeBenchmark.cells.filter((cell: any) => cell.status !== "unsupported");
    for (const [order, cell] of executableCells.entries()) {
      const program = completeBenchmark.programs.find((candidate: any) => candidate.id === cell.programId)!;
      for (const phase of ["build", "startup", "cold", "warm"] as const) {
        cell.measurements[phase] = {
          reason: null,
          samples: Array.from(
            { length: LANDING_FOUR_LANE_WARMUP_ROUNDS + LANDING_FOUR_LANE_MEASURED_ROUNDS },
            (_, round) => ({
              phase: round < LANDING_FOUR_LANE_WARMUP_ROUNDS ? "warmup" : "measured",
              round,
              order,
              wallNs: 1_000 + round,
              cpuNs: 900 + round,
              peakRssBytes: 4_096,
              validatedOutput: phase === "build" ? null : program.expectedFixedOutputs[3],
              outputObservation: phase === "build" ? null : { commandIndex: 0, mechanism: "stdout-json" },
              commands: [["synthetic-schema-fixture", phase, String(round)]],
            }),
          ),
        };
      }
    }
    expect(() => validateLandingFourLaneResult(completeBenchmark)).not.toThrow();

    const syntheticOutput = clone(completeBenchmark);
    const wasmCold = syntheticOutput.cells.find(
      (cell: any) => cell.programId === "fib" && cell.laneId === "js2-wasmgc-wasmtime-cranelift",
    );
    wasmCold.measurements.cold.samples[0].outputObservation = null;
    expect(() => validateLandingFourLaneResult(syntheticOutput)).toThrow(/outputObservation must be an object/);
  });

  it("keeps the manual canonical workflow in real benchmark mode", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/landing-four-lane-backend.yml"), "utf8");
    expect(workflow).toContain("--benchmark --canonical-ubuntu");
    expect(workflow).not.toContain("--probe --canonical-ubuntu");
    expect(workflow).toContain('"benchmarks/wasmtime-cold-host/**"');
    expect(workflow).toContain('"scripts/wasmtime-bench-child-js.mjs"');
    expect(workflow.match(/timeout-minutes: 90/g)).toHaveLength(2);
  });

  nativeIt(
    "probes both native routes and classifies every sanitizer result",
    () => {
      if (!nativeAvailable) throw new Error("LANDING_FOUR_LANE_REQUIRED=1 but Porffor/Clang are unavailable");
      const result = runProbe(fullOutput, false);
      const js2Cells = result.cells.filter((cell) => cell.laneId === "js2-shared-plan-porffor-c-native");
      const plainCells = result.cells.filter((cell) => cell.laneId === "plain-porffor-c-native");
      expect(js2Cells).toHaveLength(4);
      expect(plainCells).toHaveLength(4);
      if (js2Cells[0]!.diagnostic?.code === "select:return-type-not-resolvable") {
        // Current main before #3497/PR #3446 lands.
        for (const cell of js2Cells) {
          expect(cell).toMatchObject({
            status: "unsupported",
            validation: null,
            diagnostic: {
              phase: "js2-linear-ir-selection",
              code: "select:return-type-not-resolvable",
              followUpIssue: 3497,
            },
          });
        }
      } else {
        // Post-#3497 body/lowering gaps, verified at PR #3446 head 383d6b146.
        expect(js2Cells).toMatchObject([
          {
            programId: "fib",
            status: "unsupported",
            diagnostic: {
              phase: "js2-porffor-legality",
              code: "typed-composite-bitwise-not-lowered",
              followUpIssue: 3499,
            },
          },
          {
            programId: "fib-recursive",
            status: "unsupported",
            diagnostic: {
              phase: "js2-linear-ir-selection",
              code: "select:call-graph-closure",
              followUpIssue: 3500,
            },
          },
          {
            programId: "array-sum",
            status: "unsupported",
            diagnostic: { phase: "js2-linear-ir-build", code: "build", followUpIssue: 3501 },
          },
          {
            programId: "string-hash",
            status: "unsupported",
            diagnostic: { phase: "js2-linear-ir-build", code: "build", followUpIssue: 3502 },
          },
        ]);
      }
      for (const [index, cell] of plainCells.entries()) {
        const program = result.programs[index]!;
        expect(cell).toMatchObject({
          status: "unsafe-non-authoritative",
          sourceSha256: program.sha256,
          sanitizer: { status: "finding", authority: "ub-contaminated-non-authoritative" },
        });
        expect(cell.validation?.actualOutputs).toEqual(program.expectedFixedOutputs);
        expect(cell.sanitizer.diagnostic).toContain("runtime error: store to misaligned address");
        const rawCli = join(fullOutput, "artifacts", program.id, "plain", "porffor-cli-raw.c");
        expect(statSync(rawCli).size).toBe(LANDING_BENCHMARK_PROGRAMS[index]!.plainPorfforCliCBytes);
      }

      const hiddenFinding = clone(result);
      const unsafe = hiddenFinding.cells.find((cell) => cell.status === "unsafe-non-authoritative")!;
      unsafe.status = "supported";
      expect(() => validateLandingFourLaneResult(hiddenFinding)).toThrow(/hides a plain-Porffor sanitizer finding/);
    },
    180_000,
  );
});

function runProbe(output: string, withoutPorffor: boolean): LandingFourLaneResult {
  rmSync(output, { recursive: true, force: true });
  const command = [
    "--import",
    "tsx",
    "scripts/benchmark-landing-four-lane.mts",
    "--probe",
    ...(withoutPorffor ? ["--without-porffor"] : []),
    "--output",
    output,
  ];
  const executed = spawnSync(process.execPath, command, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
  const latest = JSON.parse(readFileSync(join(output, "latest.json"), "utf8")) as LandingFourLaneResult;
  const summary = readFileSync(join(output, "summary.md"), "utf8");
  expect(summary).toContain("`latest.json` is the authoritative artifact");
  expect(summary).toContain("UB-contaminated, non-authoritative");
  validateLandingFourLaneResult(latest);
  return latest;
}

function clone(value: LandingFourLaneResult): any {
  return JSON.parse(JSON.stringify(value));
}
