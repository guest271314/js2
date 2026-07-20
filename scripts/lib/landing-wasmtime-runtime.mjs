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
export const LANDING_WASMTIME_WARM_VALIDATION_EXPORT = "landing_validate";

export function landingWasmtimeWarmDriverSource(warmupIterations = 5, measuredIterations = 40) {
  if (!Number.isInteger(warmupIterations) || warmupIterations < 0) throw new Error("invalid warmup iteration count");
  if (!Number.isInteger(measuredIterations) || measuredIterations <= 0) {
    throw new Error("invalid measured iteration count");
  }
  return `
/** @param {number} __n @returns {number} */
export function warm(__n) {
  for (let __w = 0; __w < ${warmupIterations}; __w++) { run(__n); }
  let __best = 1e18;
  let __sink = 0;
  for (let __m = 0; __m < ${measuredIterations}; __m++) {
    const __t0 = performance.now();
    const __r = run(__n);
    const __dt = performance.now() - __t0;
    __sink = (__sink + __r) | 0;
    if (__dt < __best) __best = __dt;
  }
  if (__sink === 0x7fffffff) return -1;
  return __best;
}

/** @param {number} __n @returns {number} */
export function ${LANDING_WASMTIME_WARM_VALIDATION_EXPORT}(__n) {
  return run(__n);
}
`;
}

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
