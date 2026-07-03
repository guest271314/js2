import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

/**
 * #3009 — harden the strict `--no-host-imports` host-import degrade path.
 *
 * Under `--target standalone` + `strictNoHostImports`, `console.log(<string>)`
 * lowers to `console_log_string(externref)` plus the `__str_to_extern` native
 * bridge (src/codegen/native-strings.ts). That bridge bakes calls to the late
 * imports `__str_from_mem` / `__str_to_mem` / `__str_extern_len`, none of which
 * are on the dual-mode allowlist. With the strict gate ON these three imports
 * are dropped (a `degrade` diagnostic), so `ensureLateImport(...)!` returns
 * `undefined`, which gets baked into the helper body as `{op:"call", funcIdx:
 * undefined}`. At finalize `absoluteFuncIndex` used to hard-throw the opaque
 * internal error:
 *
 *   Codegen error: absoluteFuncIndex: stable handle undefined (ordinal NaN)
 *   has no recorded position
 *
 * The fix records the dropped host imports on the module and turns that opaque
 * crash into a clean, actionable leak diagnostic that NAMES the coupled import(s).
 */
describe("#3009 strict-mode dropped-import degrade hardening", () => {
  it("console.log under strict standalone yields a clean, named leak diagnostic (no opaque ordinal-NaN crash)", async () => {
    const r: any = await compile(`console.log("hello");`, {
      fileName: "t.ts",
      target: "standalone",
      strictNoHostImports: true,
    });

    // The compile still fails (the feature has no Wasm-native standalone path
    // yet) — but cleanly, not via the internal-error stack.
    expect(r.success).toBe(false);
    const messages: string[] = (r.errors ?? []).map((e: any) => e.message);
    const joined = messages.join("\n");

    // The opaque internal crash message must be gone.
    expect(joined).not.toContain("stable handle undefined");
    expect(joined).not.toContain("ordinal NaN");

    // A clean, actionable diagnostic that names the coupled dropped import(s).
    const fatal = messages.find((m) => m.startsWith("Codegen error:"));
    expect(fatal).toBeDefined();
    expect(fatal).toContain("unresolved call target");
    expect(fatal).toContain("env.__str_from_mem");
    expect(fatal).toContain("env.__str_to_mem");
    expect(fatal).toContain("env.__str_extern_len");
    // Actionable: points the reader at the standalone-strict cause + tracking.
    expect(fatal).toMatch(/no Wasm-native standalone path/);
    expect(fatal).toContain("#2961");
  });

  it("does not perturb non-strict lanes: a normal gc compile still succeeds", async () => {
    const r: any = await compile(`console.log("hi", 42);`, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    expect(r.binary.length).toBeGreaterThan(0);
  });

  it("does not perturb non-strict standalone compiles that need no dropped host import", async () => {
    const r: any = await compile(`export function f(a: number, b: number) { return a + b; }`, {
      fileName: "t.ts",
      target: "standalone",
    });
    expect(r.success).toBe(true);
    expect(r.binary.length).toBeGreaterThan(0);
  });
});
