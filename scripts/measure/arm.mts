// #2980 rule-5 A/B — one arm. Reads .tmp/ab-corpus.json, runs each file
// standalone via runTest262File, writes .tmp/ab-<arm>.jsonl [{file,bucket,status}].
// The carrier-widen gate is read at module-load from JS2WASM_ASYNC_CARRIER_WIDEN,
// so the LAUNCHING SHELL sets it: off arm unset, on arm =1. Run twice.
import { readFileSync, writeFileSync } from "fs";
import { runTest262File } from "../../tests/test262-runner.js";

// A standalone async test's module can throw a wasm trap INSIDE the host
// Promise bridge (`new Promise(executor)` in runtime.ts) whose rejection is
// never awaited by the runner → an unhandledRejection that (Node default
// `--unhandled-rejections=throw`) kills the whole batch. Swallow both so one
// crashing test doesn't abort the measure; the file's status is already
// determined by runTest262File's classified return.
process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});

const arm = process.argv[2] ?? (process.env.JS2WASM_ASYNC_CARRIER_WIDEN === "1" ? "on" : "off");
const corpus: { file: string; bucket: string; category: string }[] = JSON.parse(
  readFileSync(".tmp/ab-corpus.json", "utf8"),
);

const out: string[] = [];
let done = 0;
for (const { file, bucket, category } of corpus) {
  let status = "error";
  try {
    const res = await runTest262File(file, category, 20000, "standalone");
    status = res.status;
  } catch (e) {
    status = `runner_error:${(e as Error).message?.slice(0, 40)}`;
  }
  out.push(JSON.stringify({ file: file.replace("test262/test/", ""), bucket, status }));
  done++;
  if (done % 40 === 0) console.error(`[${arm}] ${done}/${corpus.length}`);
}
writeFileSync(`.tmp/ab-${arm}.jsonl`, out.join("\n") + "\n");
console.error(`[${arm}] wrote ${out.length} -> .tmp/ab-${arm}.jsonl`);
