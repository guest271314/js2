// Reusable structural differential-AST comparison for the acorn dogfood loop.
//
// This is the keystone shared by #1710 (the harness that surfaces failures) and
// #1712 (the acceptance gate: "compiled-acorn parses identically to node-acorn").
// Keep it dependency-free and pure so both consumers can import it directly.
//
// Design decisions (recorded per the #1710 spec):
//  - We compare two acorn ASTs (plain JSON-like object graphs) structurally.
//  - Position fields (`start`, `end`, `loc`, `range`) are IGNORED by default
//    (`ignorePositions: true`): they are byte offsets that are correct-by-
//    construction in node-acorn but are an unhelpful source of noise when the
//    only interesting question is "is the tree SHAPE + node kinds + literal
//    values identical?". A compiled-acorn that produces the right tree but
//    slightly different offsets is a far smaller (and different) bug than one
//    that produces the wrong node kind; we want the latter to dominate the
//    report. Set `ignorePositions: false` to include them once shape is clean.
//  - `regex` literal `value` is a RegExp instance (non-JSON); we compare its
//    `source`+`flags` via the sibling `regex: {pattern, flags}` field acorn
//    also emits, and skip the live RegExp object.
//  - BigInt literal `value` is compared by its string form.
//  - We report the FIRST divergence with a JSON-path pointer plus expected
//    (oracle) vs actual (compiled) snapshots, which is what the triage in
//    #1711 buckets on.

const POSITION_KEYS = new Set(["start", "end", "loc", "range"]);

/**
 * @typedef {Object} AstDivergence
 * @property {string} path        JSONPath-ish pointer to the diverging node/field
 * @property {string} reason      machine-readable divergence category
 * @property {unknown} expected   oracle (node-acorn) value at that path
 * @property {unknown} actual     compiled-acorn value at that path
 */

/**
 * Structurally compare two acorn ASTs.
 *
 * @param {unknown} expected  oracle AST (node-acorn)
 * @param {unknown} actual    AST produced by compiled-acorn
 * @param {{ignorePositions?: boolean, maxDivergences?: number}} [opts]
 * @returns {{equal: boolean, divergences: AstDivergence[]}}
 */
export function diffAst(expected, actual, opts = {}) {
  const ignorePositions = opts.ignorePositions !== false; // default true
  const maxDivergences = opts.maxDivergences ?? 1;
  /** @type {AstDivergence[]} */
  const divergences = [];

  walk(expected, actual, "$", { ignorePositions, maxDivergences, divergences });

  return { equal: divergences.length === 0, divergences };
}

function snapshot(v) {
  // Shallow, JSON-safe snapshot for reporting — never dump the whole subtree.
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return `[Array(${v.length})]`;
  if (v instanceof RegExp) return `/${v.source}/${v.flags}`;
  if (typeof v === "bigint") return `${v.toString()}n`;
  const kind = v.type ?? Object.keys(v).slice(0, 4).join(",");
  return `{${kind}}`;
}

function record(ctx, path, reason, expected, actual) {
  if (ctx.divergences.length >= ctx.maxDivergences) return true; // stop
  ctx.divergences.push({
    path,
    reason,
    expected: snapshot(expected),
    actual: snapshot(actual),
  });
  return ctx.divergences.length >= ctx.maxDivergences;
}

function walk(exp, act, path, ctx) {
  if (ctx.divergences.length >= ctx.maxDivergences) return;

  // Primitives + null
  if (exp === null || typeof exp !== "object") {
    // Normalize NaN / -0 the way structural equality should treat them
    if (typeof exp === "number" && typeof act === "number") {
      if (Number.isNaN(exp) && Number.isNaN(act)) return;
      if (exp !== act) record(ctx, path, "number-mismatch", exp, act);
      return;
    }
    if (typeof exp === "bigint" || typeof act === "bigint") {
      if (String(exp) !== String(act)) record(ctx, path, "bigint-mismatch", exp, act);
      return;
    }
    if (exp !== act) record(ctx, path, "primitive-mismatch", exp, act);
    return;
  }

  // RegExp literal `value` is a live RegExp — compare by source+flags
  if (exp instanceof RegExp || act instanceof RegExp) {
    const es = exp instanceof RegExp ? `/${exp.source}/${exp.flags}` : String(exp);
    const as = act instanceof RegExp ? `/${act.source}/${act.flags}` : String(act);
    if (es !== as) record(ctx, path, "regexp-mismatch", exp, act);
    return;
  }

  if (act === null || typeof act !== "object") {
    record(ctx, path, "type-mismatch", exp, act);
    return;
  }

  const expIsArr = Array.isArray(exp);
  const actIsArr = Array.isArray(act);
  if (expIsArr !== actIsArr) {
    record(ctx, path, "array-vs-object", exp, act);
    return;
  }

  if (expIsArr) {
    if (exp.length !== act.length) {
      record(ctx, path, "array-length-mismatch", `len=${exp.length}`, `len=${act.length}`);
      return;
    }
    for (let i = 0; i < exp.length; i++) {
      walk(exp[i], act[i], `${path}[${i}]`, ctx);
      if (ctx.divergences.length >= ctx.maxDivergences) return;
    }
    return;
  }

  // Objects: compare the union of keys, skipping position fields if requested.
  const keys = new Set([...Object.keys(exp), ...Object.keys(act)]);
  for (const k of keys) {
    if (ctx.ignorePositions && POSITION_KEYS.has(k)) continue;
    const hasExp = Object.prototype.hasOwnProperty.call(exp, k);
    const hasAct = Object.prototype.hasOwnProperty.call(act, k);
    const childPath = `${path}.${k}`;
    if (hasExp && !hasAct) {
      record(ctx, childPath, "missing-field", exp[k], undefined);
      if (ctx.divergences.length >= ctx.maxDivergences) return;
      continue;
    }
    if (!hasExp && hasAct) {
      record(ctx, childPath, "extra-field", undefined, act[k]);
      if (ctx.divergences.length >= ctx.maxDivergences) return;
      continue;
    }
    walk(exp[k], act[k], childPath, ctx);
    if (ctx.divergences.length >= ctx.maxDivergences) return;
  }
}

/**
 * Convenience: parse `source` with both parsers and diff the result.
 * `parseOracle` and `parseActual` each take (source, options) and return an AST
 * (or throw). Returns the diff plus any parse error captured from either side.
 *
 * @param {(src: string, opts: object) => unknown} parseOracle
 * @param {(src: string, opts: object) => unknown} parseActual
 * @param {string} source
 * @param {object} parseOptions  acorn parse options (ecmaVersion, sourceType, ...)
 * @param {{ignorePositions?: boolean, maxDivergences?: number}} [diffOpts]
 */
export function diffParse(parseOracle, parseActual, source, parseOptions, diffOpts) {
  let oracleAst, oracleErr, actualAst, actualErr;
  try {
    oracleAst = parseOracle(source, parseOptions);
  } catch (e) {
    oracleErr = e instanceof Error ? e.message : String(e);
  }
  try {
    actualAst = parseActual(source, parseOptions);
  } catch (e) {
    actualErr = e instanceof Error ? e.message : String(e);
  }

  if (oracleErr || actualErr) {
    return {
      equal: false,
      oracleError: oracleErr ?? null,
      actualError: actualErr ?? null,
      divergences:
        oracleErr && actualErr
          ? [] // both threw — treat as a parse-error case, not a structural diff
          : [
              {
                path: "$",
                reason: oracleErr ? "oracle-threw" : "actual-threw",
                expected: oracleErr ?? "(parsed ok)",
                actual: actualErr ?? "(parsed ok)",
              },
            ],
    };
  }

  const r = diffAst(oracleAst, actualAst, diffOpts);
  return { ...r, oracleError: null, actualError: null };
}
