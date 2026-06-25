// Dogfood probe DRIVER (#2674) — parent side of the worker-thread watchdog probe.
//
// Runs a compiled-acorn entry point (`parse` by default) in probe-worker.mjs and:
//   - on success, prints the returned AST summary + timing;
//   - on a HANG (synchronous in-Wasm infinite loop), terminates the worker after
//     the watchdog budget and prints the live host-call SIGNATURE read from the
//     SharedArrayBuffer (which host import the loop is hammering — the localization
//     fingerprint the same-thread watchdog could never capture).
//
// Usage (via tsx so the worker can import the TS compiler):
//   node --import tsx tests/dogfood/probe-driver.mjs '<source>' [callName] [watchdogMs]
// or set PROBE_SRC / PROBE_CALL / PROBE_WATCHDOG_MS / PROBE_ARGS_JSON env vars.
import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function probe({ source, fileName, call = "parse", args = [], watchdogMs = 15000, sabSlots = 512 }) {
  const sab = new SharedArrayBuffer(sabSlots * 4);
  const counts = new Int32Array(sab);
  let keys = [];
  // Propagate the parent's tsx loader flags (`--require …/preflight.cjs`,
  // `--import …/loader.mjs`) so the worker can import the .ts compiler. The
  // driver runs under `npx tsx`, whose loader paths live in process.execArgv;
  // forward only the tsx-loader flags (drop --eval/script args).
  const tsxArgv = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const a = process.execArgv[i];
    if ((a === "--require" || a === "--import") && /tsx\//.test(process.execArgv[i + 1] ?? "")) {
      tsxArgv.push(a, process.execArgv[i + 1]);
      i++;
    }
  }
  const worker = new Worker(join(HERE, "probe-worker.mjs"), {
    workerData: { source, fileName, call, args, sab },
    execArgv: tsxArgv,
  });

  const topSignature = () =>
    [...counts]
      .map((c, i) => [keys[i] ?? `slot${i}`, c])
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

  return await new Promise((resolve) => {
    let compiled = false;
    let watchdog = null;
    const armWatchdog = () => {
      watchdog = setTimeout(() => {
        const sig = topSignature();
        worker.terminate();
        resolve({ status: "hang", watchdogMs, signature: sig });
      }, watchdogMs);
      watchdog.unref?.();
    };
    worker.on("message", (m) => {
      if (m.kind === "keys") keys = m.keys;
      else if (m.kind === "compiled") {
        compiled = true;
        armWatchdog(); // start the watchdog only for the RUN phase, not compile
      } else if (m.kind === "done") {
        if (watchdog) clearTimeout(watchdog);
        worker.terminate();
        resolve({ status: "ok", ms: m.ms, result: m.result, signature: topSignature() });
      } else if (m.kind === "error") {
        if (watchdog) clearTimeout(watchdog);
        worker.terminate();
        resolve({ status: "error", phase: m.phase, message: m.message, signature: topSignature() });
      }
    });
    worker.on("error", (e) => {
      if (watchdog) clearTimeout(watchdog);
      resolve({ status: "error", phase: "worker", message: String(e?.message ?? e), signature: topSignature() });
    });
    worker.on("exit", (code) => {
      if (!compiled) resolve({ status: "error", phase: "worker-exit", message: `exit ${code} before compile` });
    });
  });
}

// CLI entry — drives the PINNED acorn entry module (the dogfood subject) and
// parses the given input under the watchdog.
//   node --import tsx tests/dogfood/probe-driver.mjs '<jsInput>' [call] [watchdogMs]
//   e.g. node --import tsx tests/dogfood/probe-driver.mjs 'var x = 1;' parse 15000
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] ?? process.env.PROBE_INPUT ?? "var x = 1;";
  const call = process.argv[3] ?? process.env.PROBE_CALL ?? "parse";
  const watchdogMs = Number(process.argv[4] ?? process.env.PROBE_WATCHDOG_MS ?? 15000);
  const { readFileSync } = await import("node:fs");
  const { setupAcorn } = await import("./setup-acorn.mjs");
  const { entryModulePath } = setupAcorn();
  const acornSource = readFileSync(entryModulePath, "utf-8");
  console.error(`[probe] compiling acorn + running ${call}(${JSON.stringify(input)}) with ${watchdogMs}ms watchdog…`);
  const res = await probe({
    source: acornSource,
    fileName: "acorn.mjs",
    call,
    args: [input, { ecmaVersion: 2020 }],
    watchdogMs,
  });
  console.log(JSON.stringify(res, null, 2));
}
