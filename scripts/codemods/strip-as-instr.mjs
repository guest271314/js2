#!/usr/bin/env node
// strip-as-instr.mjs — #3107 cast-debt codemod.
//
// Removes redundant `X as Instr`, `X as Instr[]`, and `X as unknown as Instr`
// type assertions (AST-precise via ts-morph — never touches strings/comments or
// `as InstrBase` / `as Instr & T`). Type assertions are erased at compile time,
// so removing them cannot change emitted output PROVIDED `tsc --noEmit` still
// passes (verified separately) and byte-identity holds (prove-emit-identity).
//
// Only the OUTERMOST cast of an Instr chain is rewritten; the base expression is
// unwrapped through any `as unknown` / `as Instr` links so `X as unknown as Instr`
// collapses fully to `X`. Spans are spliced into the on-disk text in descending
// offset order, preserving exact formatting of everything else.
//
// Usage:
//   node strip-as-instr.mjs --root <srcDir> [--dry] [--json] [file ...]
//     --root DIR   source root to scan (default: src)
//     --dry        report only; do not write
//     --json       emit a machine-readable JSON summary
//     [file ...]   restrict to these files (paths relative to root or absolute)
import { Project, SyntaxKind } from "ts-morph";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DRY = has("--dry");
const JSON_OUT = has("--json");
const root = resolve(valOf("--root", "src"));
const explicitFiles = argv.filter((a) => !a.startsWith("--") && a !== valOf("--root", "src") && a !== root);

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: { allowJs: false },
});

if (explicitFiles.length) {
  for (const f of explicitFiles) project.addSourceFileAtIfExists(resolve(f));
} else {
  project.addSourceFilesAtPaths(`${root}/**/*.ts`);
}

const INSTR = "Instr";
const INSTR_ARR = "Instr[]";

function typeText(asExpr) {
  const tn = asExpr.getTypeNode();
  return tn ? tn.getText() : "";
}
function isInstrCast(asExpr) {
  const t = typeText(asExpr);
  return t === INSTR || t === INSTR_ARR;
}

// Transform = SUFFIX-DELETION. For an AsExpression `EXPR as T`, delete only the
// ` as T` tail: span [EXPR.getEnd(), node.getEnd()]. This leaves EXPR (and any
// casts nested inside it) intact, and — crucially — the tails of nested casts
// are provably DISJOINT (each tail sits after its own operand), so stripping
// every targeted node in one pass is overlap-free. This correctly handles
// `[ e1 as Instr, e2 as Instr ] as Instr[]` (all three tails removed) and
// `X as unknown as Instr` (both tails removed) — the whole-node-replace approach
// silently preserved the inner element casts.
//
// Targets: every AsExpression whose type is `Instr`/`Instr[]`, PLUS every
// `as unknown` link whose parent AsExpression is itself an Instr cast (the
// `as unknown` in an `as unknown as Instr` chain).
let totalInstr = 0,
  totalArr = 0,
  totalUnknown = 0,
  filesChanged = 0;
const perFile = {};

for (const sf of project.getSourceFiles()) {
  const path = sf.getFilePath();
  const asNodes = sf.getDescendantsOfKind(SyntaxKind.AsExpression);

  const edits = [];
  let cInstr = 0,
    cArr = 0,
    cUnknown = 0;
  for (const n of asNodes) {
    const t = typeText(n);
    if (t === INSTR || t === INSTR_ARR) {
      if (t === INSTR_ARR) cArr++;
      else cInstr++;
      edits.push({ start: n.getExpression().getEnd(), end: n.getEnd() });
    } else if (t === "unknown") {
      // strip `as unknown` only when it feeds an Instr cast (chain link)
      const parent = n.getParent();
      if (parent && parent.getKind() === SyntaxKind.AsExpression && isInstrCast(parent)) {
        cUnknown++;
        edits.push({ start: n.getExpression().getEnd(), end: n.getEnd() });
      }
    }
  }
  if (!edits.length) continue;

  totalInstr += cInstr;
  totalArr += cArr;
  totalUnknown += cUnknown;
  perFile[path] = { instr: cInstr, instrArr: cArr, unknownInstr: cUnknown };

  if (!DRY) {
    let text = readFileSync(path, "utf8");
    // descending by start so earlier offsets stay valid; tails are disjoint.
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) {
      text = text.slice(0, e.start) + text.slice(e.end);
    }
    writeFileSync(path, text);
  }
  filesChanged++;
}

const summary = {
  dry: DRY,
  filesChanged,
  totalInstr,
  totalInstrArr: totalArr,
  totalUnknownInstr: totalUnknown,
  grandTotal: totalInstr + totalArr,
};
if (JSON_OUT) {
  console.log(JSON.stringify({ summary, perFile }, null, 2));
} else {
  console.log(
    `[strip-as-instr]${DRY ? " DRY" : ""} files=${filesChanged} ` +
      `Instr=${totalInstr} Instr[]=${totalArr} (of which unknown-chains=${totalUnknown}) ` +
      `grandTotal=${summary.grandTotal}`,
  );
  const top = Object.entries(perFile)
    .sort((a, b) => b[1].instr + b[1].instrArr - (a[1].instr + a[1].instrArr))
    .slice(0, 12);
  for (const [p, c] of top) console.log(`  ${c.instr + c.instrArr}\t${p.replace(root, "src")}`);
}
