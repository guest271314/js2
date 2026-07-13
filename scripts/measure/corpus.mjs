// #2980 rule-5 A/B — corpus selector. Deterministic spread-sample per construct
// bucket (every k-th file across the sorted list so the sample spans the dir).
// Writes .tmp/ab-corpus.json  [{file, bucket, category}] — the SAME list both arms run.
import { readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = "test262/test";

function walk(dir) {
  const out = [];
  let ents;
  try {
    ents = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of ents.sort()) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".js") && !e.includes("_FIXTURE")) out.push(p);
  }
  return out;
}

// Deterministic spread-sample: pick `n` files spread evenly across the sorted list.
function spread(files, n) {
  const sorted = files.slice().sort();
  if (sorted.length <= n) return sorted;
  const step = sorted.length / n;
  const picked = [];
  for (let i = 0; i < n; i++) picked.push(sorted[Math.floor(i * step)]);
  return picked;
}

// Bucket definitions (dirs) + target sample size, mirroring the 07-02 measure
// (60 per big bucket, 22 await-expr → 262 total).
const BUCKETS = [
  {
    bucket: "async-function",
    n: 60,
    dirs: ["language/statements/async-function", "language/expressions/async-function"],
    category: "language/async-function",
  },
  {
    bucket: "for-await-of",
    n: 60,
    dirs: ["language/statements/for-await-of"],
    category: "language/for-await-of",
  },
  {
    bucket: "async-generator",
    n: 60,
    dirs: ["language/statements/async-generator", "language/expressions/async-generator"],
    category: "language/async-generator",
  },
  {
    bucket: "promise-then-all",
    n: 60,
    dirs: ["built-ins/Promise/all", "built-ins/Promise/race", "built-ins/Promise/allSettled", "built-ins/Promise/any"],
    category: "built-ins/Promise",
  },
  {
    bucket: "await-expr",
    n: 22,
    dirs: ["language/expressions/await"],
    category: "language/await",
  },
  // (#2980, 2026-07-10) The class-async SUPPLEMENT — the tradeoff doc
  // (plan/log/2980-carrier-widen-tradeoff.md §6 point 5) makes this a SIXTH
  // blocking bucket for rule 1 (the historical −601 blast radius the five
  // construct buckets undersample): class bodies filtered to async
  // method/element shapes.
  {
    bucket: "class-async",
    n: 60,
    dirs: ["language/expressions/class", "language/statements/class"],
    filter: "async",
    category: "language/class-async",
  },
];

// Optional single-bucket run: MEASURE_BUCKET=<name> node scripts/measure/corpus.mjs
const only = process.env.MEASURE_BUCKET;

const corpus = [];
for (const b of BUCKETS) {
  if (only && b.bucket !== only) continue;
  let files = [];
  for (const d of b.dirs) files.push(...walk(join(ROOT, d)));
  if (b.filter) files = files.filter((f) => f.includes(b.filter));
  const picked = spread(files, b.n);
  for (const f of picked) corpus.push({ file: f, bucket: b.bucket, category: b.category });
  console.error(`${b.bucket}: ${files.length} available -> ${picked.length} sampled`);
}
writeFileSync(".tmp/ab-corpus.json", JSON.stringify(corpus, null, 0));
console.error(`total corpus: ${corpus.length} -> .tmp/ab-corpus.json`);
