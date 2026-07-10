// #2980 rule-5 A/B — per-bucket net + regression/fix listing.
// Joins .tmp/ab-off.jsonl vs .tmp/ab-on.jsonl by file.
import { readFileSync } from "fs";

type Row = { file: string; bucket: string; status: string };
const load = (p: string): Row[] =>
  readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const off = load(".tmp/ab-off.jsonl");
const onMap = new Map(load(".tmp/ab-on.jsonl").map((r) => [r.file, r.status]));
const isPass = (s: string) => s === "pass";

const buckets = new Map<
  string,
  { n: number; offPass: number; onPass: number; fixed: Row[]; regressed: { r: Row; onStatus: string }[] }
>();

for (const r of off) {
  const b = buckets.get(r.bucket) ?? { n: 0, offPass: 0, onPass: 0, fixed: [], regressed: [] };
  b.n++;
  const onStatus = onMap.get(r.file) ?? "MISSING";
  if (isPass(r.status)) b.offPass++;
  if (isPass(onStatus)) b.onPass++;
  if (!isPass(r.status) && isPass(onStatus)) b.fixed.push(r);
  if (isPass(r.status) && !isPass(onStatus)) b.regressed.push({ r, onStatus });
  buckets.set(r.bucket, b);
}

const order = ["async-function", "for-await-of", "async-generator", "promise-then-all", "await-expr"];
console.log("\n| bucket           | n   | off-pass | on-pass | net    | +fixed/-regressed |");
console.log("| ---------------- | --- | -------- | ------- | ------ | ----------------- |");
let tn = 0,
  toff = 0,
  ton = 0,
  tf = 0,
  tr = 0;
const blockers: string[] = [];
for (const name of order) {
  const b = buckets.get(name);
  if (!b) continue;
  const net = b.onPass - b.offPass;
  tn += b.n;
  toff += b.offPass;
  ton += b.onPass;
  tf += b.fixed.length;
  tr += b.regressed.length;
  if (net <= -2) blockers.push(`${name} (${net})`);
  console.log(
    `| ${name.padEnd(16)} | ${String(b.n).padEnd(3)} | ${String(b.offPass).padEnd(8)} | ${String(b.onPass).padEnd(7)} | ${(net >= 0 ? "+" + net : String(net)).padEnd(6)} | +${b.fixed.length} / -${b.regressed.length}`.padEnd(
      20,
    ) + " |",
  );
}
const tnet = ton - toff;
console.log(
  `| **TOTAL**        | ${String(tn).padEnd(3)} | ${String(toff).padEnd(8)} | ${String(ton).padEnd(7)} | ${(tnet >= 0 ? "+" + tnet : String(tnet)).padEnd(6)} | +${tf} / -${tr}`.padEnd(
    20,
  ) + " |",
);

console.log(
  `\nFLIP-BLOCKERS (bucket net <= -2, rule 1): ${blockers.length ? blockers.join(", ") : "NONE — all buckets net > -2"}`,
);
console.log(
  `FLIP VERDICT (rule 1: positive total net AND no bucket net <= -2): ${tnet > 0 && blockers.length === 0 ? "FLIP" : "NO FLIP"}`,
);

// Regression signatures per bucket (what shape is blocking).
for (const name of order) {
  const b = buckets.get(name);
  if (!b || b.regressed.length === 0) continue;
  console.log(`\n--- ${name}: ${b.regressed.length} regressed (pass->X) ---`);
  const sig = new Map<string, number>();
  for (const { onStatus } of b.regressed) sig.set(onStatus, (sig.get(onStatus) ?? 0) + 1);
  for (const [s, c] of [...sig.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c}x ${s}`);
  for (const { r, onStatus } of b.regressed.slice(0, 6)) console.log(`    ${onStatus.padEnd(8)} ${r.file}`);
}
