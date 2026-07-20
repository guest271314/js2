// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** String operations whose observable behavior is shared by every IR backend. */
export type IrStringRuntimeIntrinsic = "constant" | "concat" | "length" | "char-at" | "char-code-at";

export type IrStringRuntimeOperand = "string" | "number-index";
export type IrStringRuntimeResult = "string" | "number";

export interface IrStringIndexContract {
  readonly conversion: "ToIntegerOrInfinity";
  readonly unit: "utf16-code-unit";
  readonly omitted: 0;
  readonly outOfBounds: "empty-string" | "nan";
}

export interface IrStringRuntimeSpec {
  readonly operands: readonly IrStringRuntimeOperand[];
  readonly result: IrStringRuntimeResult;
  readonly allocatesResult: boolean;
  readonly index?: IrStringIndexContract;
}

const CHAR_AT_INDEX: IrStringIndexContract = Object.freeze({
  conversion: "ToIntegerOrInfinity",
  unit: "utf16-code-unit",
  omitted: 0,
  outOfBounds: "empty-string",
});

const CHAR_CODE_AT_INDEX: IrStringIndexContract = Object.freeze({
  conversion: "ToIntegerOrInfinity",
  unit: "utf16-code-unit",
  omitted: 0,
  outOfBounds: "nan",
});

/**
 * Semantic ABI for typed string IR. It contains no artifact symbols or
 * instruction encodings; concrete backends bind these operations separately.
 */
export const IR_STRING_RUNTIME: Readonly<Record<IrStringRuntimeIntrinsic, IrStringRuntimeSpec>> = Object.freeze({
  constant: Object.freeze({ operands: Object.freeze([]), result: "string", allocatesResult: true }),
  concat: Object.freeze({
    operands: Object.freeze(["string", "string"] as const),
    result: "string",
    allocatesResult: true,
  }),
  length: Object.freeze({ operands: Object.freeze(["string"] as const), result: "number", allocatesResult: false }),
  "char-at": Object.freeze({
    operands: Object.freeze(["string", "number-index"] as const),
    result: "string",
    allocatesResult: true,
    index: CHAR_AT_INDEX,
  }),
  "char-code-at": Object.freeze({
    operands: Object.freeze(["string", "number-index"] as const),
    result: "number",
    allocatesResult: false,
    index: CHAR_CODE_AT_INDEX,
  }),
});

/** ECMAScript ToIntegerOrInfinity after the caller has performed ToNumber. */
export function toIntegerOrInfinity(value: number): number {
  if (Number.isNaN(value) || value === 0) return value === 0 ? value : 0;
  if (!Number.isFinite(value)) return value;
  return Math.trunc(value);
}

/** Reference semantics used by backend-independent evidence tests. */
export function utf16CharCodeAt(value: string, position: number | undefined): number {
  const index = toIntegerOrInfinity(position ?? 0);
  if (!Number.isFinite(index) || index < 0 || index >= value.length) return Number.NaN;
  return value.charCodeAt(index);
}

/** Reference semantics used by backend-independent evidence tests. */
export function utf16CharAt(value: string, position: number | undefined): string {
  const codeUnit = utf16CharCodeAt(value, position);
  return Number.isNaN(codeUnit) ? "" : String.fromCharCode(codeUnit);
}
