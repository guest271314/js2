// #2138 Slice 1 acceptance probe — byte-identity corpus diff.
// Usage: npx tsx .tmp/byte-diff-2138.mts <compilerRoot> <outFile>
// Compiles a fixed corpus (example files + deterministic test262 sample) with
// the compiler at <compilerRoot> and writes JSONL of {file, mode, status, sha,
// errs} for diffing between baseline (upstream/main) and the #2138 branch.
import { readFileSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const compilerRoot = process.argv[2]!;
const outFile = process.argv[3]!;
const { compile } = await import(pathToFileURL(join(compilerRoot, "src/index.ts")).href);

// Inputs always come from the SAME fixed locations so both sides compile
// identical sources.
const INPUT_ROOT = "/workspace";
const STRIDE = Number(process.env.STRIDE ?? 20);

function walk(root: string, ext: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(dir, name);
      const s = lstatSync(p);
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) stack.push(p);
      else if (name.endsWith(ext) && !name.endsWith(".d.ts") && !name.includes("_FIXTURE")) out.push(p);
    }
  }
  return out.sort();
}

const examples = [
  ...walk(join(INPUT_ROOT, "website/playground/examples"), ".ts"),
  ...walk(join(INPUT_ROOT, "examples"), ".ts"),
];
const t262all = walk(join(INPUT_ROOT, "test262/test"), ".js");
const t262 = t262all.filter((_, i) => i % STRIDE === 0);

const lines: string[] = [];
let n = 0;
function record(file: string, mode: string, src: string, opts: Record<string, unknown>) {
  let status: string;
  let sha: string | null = null;
  let errs = -1;
  try {
    const r = compile(src, { fileName: "test.ts", ...opts });
    errs = r.errors?.length ?? 0;
    if (r.success && r.binary) {
      status = "ok";
      sha = createHash("sha256").update(r.binary).digest("hex");
    } else {
      status = "ce:" + (r.errors?.[0]?.message ?? "").slice(0, 120);
    }
  } catch (e) {
    status = "throw:" + String(e instanceof Error ? e.message : e).slice(0, 120);
  }
  lines.push(JSON.stringify({ file: file.replace(INPUT_ROOT, ""), mode, status, sha, errs }));
  if (++n % 250 === 0) process.stderr.write(`  ${n} compiled\n`);
}

for (const f of examples) {
  const src = readFileSync(f, "utf-8");
  record(f, "default", src, {});
  record(f, "wasi", src, { target: "wasi" });
}
for (const f of t262) {
  const src = readFileSync(f, "utf-8");
  record(f, "default", src, {});
}
writeFileSync(outFile, lines.join("\n") + "\n");
process.stderr.write(`done: ${n} compiles → ${outFile}\n`);
