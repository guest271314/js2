// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared low-level emit helpers for the closures subsystem (issue #3270 DRY
 * cleanup). Leaf module: imports only IR/context TYPES + a couple of leaf emit
 * primitives, so both `closures.ts` and the extracted param-init module can
 * depend on it without an import cycle. Each helper factors an emission idiom
 * that was copy-pasted across several call sites into ONE place; every call site
 * is a byte-identical replacement (proven by scripts/prove-emit-identity.mjs).
 */

import type { Instr, ValType } from "../../ir/types.js";
import type { FunctionContext } from "../context/types.js";

/**
 * (#3270 dedup) Append a detached destructuring instruction sequence to
 * `fctx.body`, wrapping it in a `ref.is_null`-guarded else-arm on `srcIdx` when
 * the source param is nullable (`nullable`) and there is anything to guard.
 * Mirrors the "close null guard" tail that the arrow/method param-destructuring
 * paths each open-coded identically.
 */
export function spliceNullGuarded(fctx: FunctionContext, srcIdx: number, nullable: boolean, instrs: Instr[]): void {
  if (nullable && instrs.length > 0) {
    fctx.body.push({ op: "local.get", index: srcIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: instrs });
  } else {
    fctx.body.push(...instrs);
  }
}

/**
 * (#3270 dedup) Emit the trailing default return value for a lifted closure /
 * callback body: when the function has a non-void `returnType` and the body did
 * NOT already leave a value (`alreadyHasValue`), and its last instruction isn't
 * an explicit `return`, push the zero value of the return kind (`f64.const 0` /
 * `i32.const 0` / `ref.null.extern`). Other kinds are left untouched, exactly as
 * the open-coded arrow-closure and arrow-callback tails did.
 */
export function emitDefaultReturnValue(
  fctx: FunctionContext,
  returnType: ValType | null,
  alreadyHasValue: boolean,
): void {
  if (returnType && !alreadyHasValue) {
    const lastInstr = fctx.body[fctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (returnType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (returnType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (returnType.kind === "externref") {
        fctx.body.push({ op: "ref.null.extern" });
      }
    }
  }
}
