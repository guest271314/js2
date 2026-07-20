// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteId } from "../nodes.js";

/**
 * Typed lowering boundary for shared string instructions. Operands are already
 * present in source order on the sink; each method consumes them and pushes
 * exactly the result described by `IR_STRING_RUNTIME`.
 */
export interface StringBackendEmitter<Sink> {
  emitStringConst(value: string, alloc: AllocSiteId | undefined, out: Sink): void;
  emitStringConcat(alloc: AllocSiteId | undefined, out: Sink): void;
  emitStringLength(out: Sink): void;
  emitStringCharAt(alloc: AllocSiteId | undefined, out: Sink): void;
  emitStringCharCodeAt(out: Sink): void;
}
