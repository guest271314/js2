// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1886 — Linear-safe `Uint8Array` escape/usage analysis.
 *
 * A compile-time pre-pass (WASI / standalone only) that classifies each
 * `Uint8Array` *binding* — a `const`/`let`/`var` initialised from
 * `new Uint8Array(...)`, or a function **parameter** typed `Uint8Array` — as
 * **linear-safe** or not.
 *
 * A binding is linear-safe iff it is a pure byte-I/O buffer: it never escapes
 * to a context that needs the WasmGC heap (stored in a struct/array/global,
 * captured by a closure, returned, compared by identity, iterated, copied via
 * `.subarray`/`.slice`/`.set`, JSON-stringified, …) and its *only* uses are:
 *   - element load/store `b[i]` / `b[i] = v`
 *   - `b.length`
 *   - `process.stdin.read(b)` / `process.stdin.read(b, off)`
 *   - `process.stdout.write(b)` / `process.stderr.write(b)`
 *   - being passed as a call argument to a function whose corresponding
 *     parameter is *itself* linear-safe (interprocedural threading).
 *
 * For such bindings #1886 backs them by **linear memory** (a `(ptr, len)`
 * pair) instead of a GC vec, so `fd_read`/`fd_write` touch them with zero
 * GC↔linear copies. When the predicate cannot prove safety, the binding stays
 * a GC array — today's behaviour, byte-for-byte. The analysis is therefore
 * deliberately **conservative**: any use it does not explicitly recognise as
 * safe demotes the binding (and, transitively, any parameter it flows into).
 *
 * Output ({@link LinearUint8Result}) is consumed by codegen:
 *   - `safeBindings` — the locals + params backed by linear memory.
 *   - `linearParams` — per-function, which parameter indices are linear (so
 *     the function's wasm signature can be rewritten `Uint8Array → (ptr,len)`
 *     and every call site lowered consistently).
 *
 * This module performs **no** codegen and has no side effects on the module;
 * it is safe to run unconditionally behind the `--target wasi` gate (see
 * {@link analyzeLinearUint8} caller in `index.ts`). The codegen consumers are
 * additive (`if (isLinearSafe(sym)) {…linear…} else {…existing GC…}`), so when
 * the result set is empty the emitted module is identical to today.
 */
import { ts } from "../ts-api.js";

/** Result of the linear-safe `Uint8Array` analysis (frozen before codegen). */
export interface LinearUint8Result {
  /**
   * Symbols of every binding (local variable or parameter) proven linear-safe.
   * Codegen consults this by `checker.getSymbolAtLocation(idNode)`.
   */
  safeBindings: Set<ts.Symbol>;
  /**
   * For each function whose signature is linear-rewritten, the set of
   * parameter indices that are linear-backed. Keyed by the function's own
   * symbol. Callers use this to lower call arguments to `(ptr, len)` pairs and
   * to rewrite the callee's wasm param list.
   */
  linearParams: Map<ts.Symbol, Set<number>>;
}

/** A function-like declaration we model in the interprocedural fixpoint. */
type FnDecl = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function isFnDecl(node: ts.Node): node is FnDecl {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** True when a TS type is exactly `Uint8Array` (not a union, not a view alias). */
function isUint8ArrayType(checker: ts.TypeChecker, type: ts.Type): boolean {
  // A bare `Uint8Array` has the `Uint8Array` symbol. Reject unions / `any` /
  // `unknown` / `ArrayBuffer`-typed and `Uint8Array | ArrayBuffer` (the host
  // boundary shape) — those are not provably plain byte buffers.
  if (type.isUnion()) return false;
  const sym = type.getSymbol() ?? type.aliasSymbol;
  return sym?.name === "Uint8Array";
}

function isUint8ArrayNode(checker: ts.TypeChecker, node: ts.Expression): boolean {
  return isUint8ArrayType(checker, checker.getTypeAtLocation(node));
}

/** `new Uint8Array(...)` (the constructor target resolves to `Uint8Array`). */
function isNewUint8Array(expr: ts.Node): expr is ts.NewExpression {
  return ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Uint8Array";
}

/**
 * Recognise `process.std{in.read,out.write,err.write}(buf, …)` and return the
 * argument index that carries the buffer (0 for both), or `-1` if this is not a
 * std-stream I/O call. We only match the global `process` shape the WASI
 * lowering supports (`node-process-api.ts`); a local `process` shadow makes
 * this not match (the conservative path).
 */
function ioBufferArgIndex(call: ts.CallExpression): number {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return -1;
  const method = callee.name.text;
  const stream = callee.expression;
  if (!ts.isPropertyAccessExpression(stream)) return -1;
  const streamName = stream.name.text;
  const root = stream.expression;
  if (!(ts.isIdentifier(root) && root.text === "process")) return -1;
  if (streamName === "stdin" && method === "read") return 0;
  if ((streamName === "stdout" || streamName === "stderr") && method === "write") return 0;
  return -1;
}

/**
 * Resolve the callee `FnDecl` + symbol of a direct call `f(args)` where `f` is
 * a plain identifier bound to a user function. Returns `null` for any indirect /
 * method / unresolved callee (which is conservatively treated as an escape).
 */
function resolveDirectCallee(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): { sym: ts.Symbol; decl: FnDecl } | null {
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) return null;
  const sym = checker.getSymbolAtLocation(callee);
  if (!sym) return null;
  const decls = sym.getDeclarations() ?? [];
  for (const d of decls) {
    if (isFnDecl(d)) return { sym, decl: d };
    // `const f = (…) => …` / `const f = function(){}` — the symbol's decl is
    // the variable; unwrap its initializer.
    if (ts.isVariableDeclaration(d) && d.initializer && isFnDecl(d.initializer)) {
      return { sym, decl: d.initializer };
    }
  }
  return null;
}

/**
 * Build the linear-safe analysis for a WASI source file.
 *
 * Algorithm (monotone, terminates — classifications only ever demote):
 *  1. Collect every candidate binding: `new Uint8Array(...)` variable inits and
 *     `Uint8Array` parameters of non-exported user functions. Exported
 *     functions' params are NOT candidates (their ABI is observable).
 *  2. Seed every candidate as linear-safe.
 *  3. Fixpoint: walk each function body. A candidate binding/param is demoted
 *     if it has any disqualifying use, OR is passed to a callee parameter that
 *     is currently demoted. Repeat until no demotions occur in a full pass.
 *  4. Freeze: the survivors are the linear-safe set.
 */
export function analyzeLinearUint8(checker: ts.TypeChecker, sourceFile: ts.SourceFile): LinearUint8Result {
  // candidate bindings (locals + params), seeded safe; demote on disqualifying use.
  const safe = new Set<ts.Symbol>();
  // function symbol → its FnDecl (for param-index lookup) + whether exported.
  const fnDecls = new Map<ts.Symbol, FnDecl>();
  // function symbol → param symbols (index-aligned) that are Uint8Array candidates.
  const fnParamSyms = new Map<ts.Symbol, (ts.Symbol | undefined)[]>();

  // ---- Pass 1: collect candidates -----------------------------------------
  const collect = (node: ts.Node): void => {
    if (isNewUint8Array(node)) {
      // the binding this `new Uint8Array` initialises (if any) — handled at
      // the VariableDeclaration so we know the declared symbol.
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      if (isNewUint8Array(node.initializer) || isUint8ArrayNode(checker, node.initializer)) {
        const sym = checker.getSymbolAtLocation(node.name);
        // only `new Uint8Array(...)` inits are linear-candidates; an init from
        // another expression (a returned/aliased array) is left to the escape
        // checks (it will not be a `new` site we can back linearly).
        if (sym && isNewUint8Array(node.initializer)) safe.add(sym);
      }
    }
    if (isFnDecl(node)) {
      const fnSym = fnSymbolOf(checker, node);
      if (fnSym) {
        fnDecls.set(fnSym, node);
        const exported = isExportedFn(node);
        const paramSyms: (ts.Symbol | undefined)[] = [];
        for (const p of node.parameters) {
          let pSym: ts.Symbol | undefined;
          if (ts.isIdentifier(p.name) && isUint8ArrayNode(checker, p.name)) {
            pSym = checker.getSymbolAtLocation(p.name);
            // Exported functions: params are observable ABI — never candidates.
            if (pSym && !exported && !p.dotDotDotToken) safe.add(pSym);
          }
          paramSyms.push(pSym);
        }
        fnParamSyms.set(fnSym, paramSyms);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  // ---- Pass 2..N: fixpoint demotion ----------------------------------------
  // For each candidate symbol, scan all references; a reference in a
  // disqualifying position demotes it. Iterate until stable (a demotion can
  // cascade: demoting a param means args flowing into it are re-examined).
  let changed = true;
  while (changed) {
    changed = false;
    // Walk the whole file once; at every identifier that refers to a candidate
    // symbol, classify the use. We re-walk on each iteration because parameter
    // demotions change the safety of call-argument uses.
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const sym = checker.getSymbolAtLocation(node);
        if (sym && safe.has(sym) && !isBindingSite(node)) {
          if (!isAllowedUse(checker, node, safe, fnDecls, fnParamSyms)) {
            safe.delete(sym);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // ---- Freeze: derive per-function linear param sets -----------------------
  const linearParams = new Map<ts.Symbol, Set<number>>();
  for (const [fnSym, paramSyms] of fnParamSyms) {
    const idxs = new Set<number>();
    paramSyms.forEach((pSym, i) => {
      if (pSym && safe.has(pSym)) idxs.add(i);
    });
    if (idxs.size > 0) linearParams.set(fnSym, idxs);
  }

  return { safeBindings: safe, linearParams };
}

/** The function's own symbol (for declarations and `const f = …` forms). */
function fnSymbolOf(checker: ts.TypeChecker, node: FnDecl): ts.Symbol | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return checker.getSymbolAtLocation(node.name);
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return checker.getSymbolAtLocation(node.name);
  // function/arrow expression assigned to a variable: the variable's symbol.
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return checker.getSymbolAtLocation(parent.name);
  }
  // named function expression
  if (ts.isFunctionExpression(node) && node.name) return checker.getSymbolAtLocation(node.name);
  return undefined;
}

function isExportedFn(node: FnDecl): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  // `export const f = …`
  let p: ts.Node | undefined = node.parent;
  while (p && (ts.isVariableDeclaration(p) || ts.isVariableDeclarationList(p))) p = p.parent;
  if (p && ts.isVariableStatement(p)) {
    const sMods = ts.getModifiers(p);
    if (sMods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  }
  return false;
}

/** True if this identifier is its own declaration name (not a use). */
function isBindingSite(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isVariableDeclaration(p) && p.name === id) ||
    (ts.isParameter(p) && p.name === id) ||
    (ts.isFunctionDeclaration(p) && p.name === id) ||
    (ts.isBindingElement(p) && p.name === id)
  );
}

/**
 * Classify a single *use* (identifier reference) of a candidate buffer.
 * Returns true iff the use is one of the allowed linear-safe forms given the
 * CURRENT classification of parameters (so a demoted callee param makes a
 * call-arg use unsafe on the next iteration).
 */
function isAllowedUse(
  checker: ts.TypeChecker,
  id: ts.Identifier,
  safe: Set<ts.Symbol>,
  fnDecls: Map<ts.Symbol, FnDecl>,
  fnParamSyms: Map<ts.Symbol, (ts.Symbol | undefined)[]>,
): boolean {
  const p = id.parent;

  // b[i]  /  b[i] = v   (element access — the buffer is the object, not index)
  if (ts.isElementAccessExpression(p) && p.expression === id) return true;
  // (b)[i] grouped — TS folds parens; handle defensively below via parent walk.

  // b.length  (the only allowed property)
  if (ts.isPropertyAccessExpression(p) && p.expression === id) {
    return p.name.text === "length";
  }

  // call argument: either an I/O intrinsic, or a linear-safe callee param.
  if (ts.isCallExpression(p) && p.expression !== id) {
    const argIdx = p.arguments.indexOf(id);
    if (argIdx < 0) return false; // appears in callee position somehow → unsafe
    // process.std*.{read,write}(buf …)
    const ioIdx = ioBufferArgIndex(p);
    if (ioIdx === argIdx) return true;
    // direct user call → corresponding param must be currently linear-safe.
    const resolved = resolveDirectCallee(checker, p);
    if (!resolved) return false;
    const paramSyms = fnParamSyms.get(resolved.sym);
    if (!paramSyms) return false;
    const calleeParamSym = paramSyms[argIdx];
    return !!(calleeParamSym && safe.has(calleeParamSym));
  }

  // Parenthesised buffer: `(b)[i]`, `(b).length` — unwrap one paren level.
  if (ts.isParenthesizedExpression(p)) {
    // Re-classify the paren as if it were the buffer reference.
    return isAllowedUse(checker, p as unknown as ts.Identifier, safe, fnDecls, fnParamSyms);
  }

  // Everything else is a potential escape:
  //   return b / yield b / b as T / [b] / {x:b} / f.call(b) / obj.m(b) /
  //   const c = b / b === x / typeof b / spread / for..of / template / etc.
  return false;
}
