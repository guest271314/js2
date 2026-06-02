// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #682 — Standalone RegExp native-engine ABI scaffold.
 *
 * This file intentionally does not lower RegExp semantics yet. #1474 owns the
 * current standalone refusal gate; this module gives the future native engine
 * slice a typed, non-JS-host contract to plug into when an embedded backend is
 * linked into the generated Wasm module.
 */
import type { ValType } from "../ir/types.js";

export const STANDALONE_REGEXP_ABI_VERSION = 1;

export const STANDALONE_REGEXP_ENGINE_KIND = "quickjs-libregexp" as const;

export type StandaloneRegExpEngineKind = typeof STANDALONE_REGEXP_ENGINE_KIND;

export interface StandaloneRegExpAbiFunction {
  /**
   * Function name expected in the generated module. These are in-module
   * symbols, not `env` JS-host imports.
   */
  name: string;
  params: readonly ValType[];
  results: readonly ValType[];
}

export interface StandaloneRegExpEngineConfig {
  kind: StandaloneRegExpEngineKind;
  abiVersion: typeof STANDALONE_REGEXP_ABI_VERSION;
  functions: typeof STANDALONE_REGEXP_ABI;
}

export interface StandaloneRegExpEngineState {
  standaloneRegExpEngine?: StandaloneRegExpEngineConfig | null;
}

const I32 = { kind: "i32" } as const satisfies ValType;

/**
 * Minimal ABI boundary for the first native engine slice. Lowering code should
 * only query this contract after #1474's refusal gate is opened.
 */
export const STANDALONE_REGEXP_ABI = {
  compile: {
    name: "__re_compile",
    params: [I32, I32, I32],
    results: [I32],
  },
  exec: {
    name: "__re_exec",
    params: [I32, I32, I32, I32],
    results: [I32],
  },
  free: {
    name: "__re_free",
    params: [I32],
    results: [],
  },
  groupStart: {
    name: "__re_group_start",
    params: [I32, I32],
    results: [I32],
  },
  groupEnd: {
    name: "__re_group_end",
    params: [I32, I32],
    results: [I32],
  },
} as const satisfies Record<string, StandaloneRegExpAbiFunction>;

export function quickJsLibRegexpEngineConfig(): StandaloneRegExpEngineConfig {
  return {
    kind: STANDALONE_REGEXP_ENGINE_KIND,
    abiVersion: STANDALONE_REGEXP_ABI_VERSION,
    functions: STANDALONE_REGEXP_ABI,
  };
}

export function getStandaloneRegExpEngine(state: StandaloneRegExpEngineState): StandaloneRegExpEngineConfig | null {
  return state.standaloneRegExpEngine ?? null;
}

export function hasStandaloneRegExpEngine(state: StandaloneRegExpEngineState): boolean {
  return getStandaloneRegExpEngine(state) !== null;
}
