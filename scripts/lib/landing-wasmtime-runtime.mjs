// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Shared by the landing chart generator and the #3498 evidence runner. */
export const LANDING_WASMTIME_FEATURES = Object.freeze([
  "-W",
  "gc=y",
  "-W",
  "function-references=y",
  "-W",
  "exceptions=y",
]);

/** Keep these options aligned with the existing landing-page Wasmtime lane. */
export const LANDING_WASMTIME_COMPILE_OPTIONS = Object.freeze({
  target: "wasi",
  nativeStrings: true,
  optimize: 3,
});

export const LANDING_WASM_OPT_ARGS = Object.freeze(["--all-features", "--disable-custom-descriptors", "-O3"]);

export function landingWasmtimeCompileArgs(wasmPath, cwasmPath) {
  return ["compile", ...LANDING_WASMTIME_FEATURES, wasmPath, "-o", cwasmPath];
}

export function landingWasmtimeRunArgs(cwasmPath, exportName, argument) {
  return [
    "run",
    "--allow-precompiled",
    ...LANDING_WASMTIME_FEATURES,
    "--invoke",
    exportName,
    cwasmPath,
    String(argument),
  ];
}
