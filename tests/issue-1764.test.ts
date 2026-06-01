// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1764 — wasmtime hot-runtime benchmark cold lane models warm-engine
 * per-request context / instance setup, not full process startup.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..");

function readRepo(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("#1764 — edge-serverless benchmark methodology", () => {
  it("documents the warm-engine cold-lane fidelity caveats in the generator", () => {
    const script = readRepo("scripts/generate-wasmtime-hot-runtime.mjs");
    const host = readRepo("benchmarks/wasmtime-cold-host/src/main.rs");

    expect(script).toContain("vm.createContext()");
    expect(script).toContain("Context is lighter than a true V8 isolate");
    expect(script).toContain("benchmarks/wasmtime-cold-host");
    expect(script).toContain("fresh `Store` + `Instance`");
    expect(script).toContain("wasmtime run` CLI cannot model pooling");
    expect(script).not.toContain("WebAssembly.compile(wasm)");
    expect(script).not.toContain("timeV8WasmFreshInstance");

    expect(host).toContain("Config::new()");
    expect(host).toContain("wasm_function_references(true)");
    expect(host).toContain("wasm_gc(true)");
    expect(host).toContain("Instance::new");
    expect(host).toContain("Component::from_file");
    expect(host).toContain("--preload");
    expect(host).toContain("Instant::now()");
  });

  it("committed cold rows carry warm-engine context/instance methodology fields", () => {
    const rows = JSON.parse(readRepo("benchmarks/results/wasm-host-wasmtime-hot-runtime.json")) as Array<{
      scenario: string;
      wasmColdMode?: string;
      wasmColdEngine?: string;
      wasmColdHost?: string;
      jsColdMode?: string;
      jsColdFidelity?: string;
      jsCompiledContextUs?: number;
      wasmMinUs?: number;
      wasmMaxUs?: number;
      jsMinUs?: number;
      jsMaxUs?: number;
      javyUs?: number;
      javyColdMode?: string;
      javyColdHost?: string;
      starlingMonkeyUs?: number;
      starlingMonkeyColdMode?: string;
      starlingMonkeyColdHost?: string;
      auxiliaryColdWrapper?: string;
    }>;

    const coldRows = rows.filter((row) => row.scenario === "cold");
    expect(coldRows.length).toBeGreaterThan(0);

    for (const row of coldRows) {
      expect(row.wasmColdMode).toBe("rust-wasmtime-compile-once-fresh-store-instance");
      expect(row.wasmColdEngine).toBe("wasmtime-cranelift");
      expect(row.wasmColdHost).toBe("benchmarks/wasmtime-cold-host");
      expect(row.jsColdMode).toBe("node-vm-create-context-fresh-script");
      expect(row.jsColdFidelity).toBe("vm-context-lower-bound-vs-true-v8-isolate");
      expect(row.jsCompiledContextUs).toBeGreaterThan(0);
      expect(row.wasmMinUs).toBeGreaterThan(0);
      expect(row.wasmMaxUs).toBeGreaterThanOrEqual(row.wasmMinUs!);
      expect(row.jsMinUs).toBeGreaterThan(0);
      expect(row.jsMaxUs).toBeGreaterThanOrEqual(row.jsMinUs!);
      expect(row.auxiliaryColdWrapper).toBe("fixed-runtime-arg-no-return-wit");
      expect(row.javyColdMode).toBe("rust-wasmtime-compile-once-dynamic-plugin-fresh-store-instance");
      expect(row.javyColdHost).toBe("benchmarks/wasmtime-cold-host");
      expect(row.javyUs).toBeGreaterThan(0);
      expect(row.starlingMonkeyColdMode).toBe("rust-wasmtime-component-compile-once-fresh-store-instance");
      expect(row.starlingMonkeyColdHost).toBe("benchmarks/wasmtime-cold-host");
      expect(row.starlingMonkeyUs).toBeGreaterThan(0);
    }
  });

  it("landing-page benchmark charts fetch fresh payloads for cold auxiliary lanes", () => {
    const chart = readRepo("website/components/perf-benchmark-chart.js");
    const landing = readRepo("website/index.html");

    expect(chart).toContain('fetch(src, { cache: "no-store" })');
    expect(chart).toContain('{ key: "javyUs", label: "Interpreter" }');
    expect(chart).toContain('{ key: "starlingMonkeyUs", label: "Engine" }');
    expect(landing).toContain('fetch(src, { cache: "no-store" })');
  });

  it("keeps benchmark framing company-agnostic", () => {
    const framing = [
      readRepo("scripts/generate-wasmtime-hot-runtime.mjs"),
      readRepo("scripts/wasmtime-bench-child-js.mjs"),
      readRepo("website/index.html"),
      readRepo("benchmarks/results/wasm-host-wasmtime-hot-runtime.json"),
      readRepo("benchmarks/wasmtime-cold-host/src/main.rs"),
    ].join("\n");

    expect(framing).not.toMatch(/Cloudflare|Fastly|Workers|Compute@Edge|Fermyon|Shopify|Deno Deploy/);
  });
});
