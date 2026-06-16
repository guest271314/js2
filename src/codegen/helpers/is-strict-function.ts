// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";

const cache = new WeakMap<ts.Node, boolean>();

/** True when the prologue of `body` opens with a `"use strict"` directive. */
function hasUseStrictPrologue(statements: readonly ts.Statement[]): boolean {
  for (const s of statements) {
    // A Directive Prologue is a leading run of ExpressionStatements whose
    // expression is a string literal. The first non-directive statement ends it.
    if (ts.isExpressionStatement(s) && ts.isStringLiteralLike(s.expression)) {
      if (s.expression.text === "use strict") return true;
      continue;
    }
    break;
  }
  return false;
}

/**
 * Decide whether `fn`'s body is strict-mode code (ECMA-262 §11.2.2).
 *
 * Strict applies when any of these hold:
 *  - the function body itself opens with a `"use strict"` directive,
 *  - an enclosing function body or the SourceFile opens with `"use strict"`,
 *  - the function is a class element or lives anywhere inside a class
 *    (ClassDeclaration / ClassExpression bodies are always strict).
 *
 * ES-module strictness (§11.2.2: Module code is always strict) IS inferred —
 * but only from the **genuine** module signal `externalModuleIndicator` (set by
 * TypeScript when the ORIGINAL source has a top-level `import`/`export`), or an
 * ESM `impliedNodeFormat`. It is NOT inferred from the TS `scriptKind`: the
 * test262 harness compiles every sloppy-mode `.js` case with `fileName:
 * "test.ts"` (→ `scriptKind: TS`), and keying on that would wrongly unmap every
 * such source. A sloppy script with no top-level import/export has
 * `externalModuleIndicator === undefined`, so it stays mapped; only real module
 * input (TS/ES modules — the product's actual input) unmaps (#2119).
 *
 * This drives the mapped-vs-unmapped `arguments` split: strict functions get
 * an *unmapped* arguments object, so writes to `arguments[i]` must not flow
 * back into the named parameter (#779e).
 */
export function isStrictFunction(fn: ts.FunctionLikeDeclaration): boolean {
  const cached = cache.get(fn);
  if (cached !== undefined) return cached;

  let result = false;

  // 1. The function's own directive prologue.
  if (fn.body && ts.isBlock(fn.body) && hasUseStrictPrologue(fn.body.statements)) {
    result = true;
  }

  // 2. Walk enclosing scopes for a class context or an outer "use strict".
  if (!result) {
    for (let node: ts.Node | undefined = fn.parent; node; node = node.parent) {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        result = true;
        break;
      }
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
        if (node.body && ts.isBlock(node.body) && hasUseStrictPrologue(node.body.statements)) {
          result = true;
          break;
        }
      }
      if (ts.isSourceFile(node)) {
        // (#2119) Module code is always strict. Key only on the genuine module
        // signal (a real top-level import/export, or ESM impliedNodeFormat) —
        // NOT scriptKind — so test262 sloppy `.js` cases compiled as `test.ts`
        // (no import/export) stay sloppy/mapped.
        if (hasUseStrictPrologue(node.statements) || isModuleSourceFile(node)) {
          result = true;
        }
        break;
      }
    }
  }

  cache.set(fn, result);
  return result;
}

/**
 * (#2119) True iff `sf` is genuine module code — it carries a top-level
 * `import`/`export` (TypeScript sets the internal `externalModuleIndicator`),
 * or its implied node format is ESM. Deliberately ignores `scriptKind`: a
 * sloppy `.js` source compiled under a `.ts` filename has `scriptKind: TS` but
 * no module markers, and must stay sloppy.
 */
function isModuleSourceFile(sf: ts.SourceFile): boolean {
  const internal = sf as ts.SourceFile & { externalModuleIndicator?: ts.Node };
  if (internal.externalModuleIndicator !== undefined) return true;
  if (sf.impliedNodeFormat === ts.ModuleKind.ESNext) return true;
  return false;
}
