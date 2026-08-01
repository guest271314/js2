/**
 * #3685 step 1 — decline-reason census for `tryEmitProvenReceiverFieldGet`.
 *
 * The 2026-07-31 coverage audit measured 244 proven receiver verdicts against
 * only 88 inlined reads over one standalone acorn compile, and could not say
 * WHICH carve-out dropped the other 156. This census answers that. It is
 * instrumentation, so what needs pinning is that it is genuinely inert when the
 * env var is unset, and that when set it attributes each decline to the branch
 * that produced it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { provenReceiverStats, resetProvenReceiverStats } from "../src/codegen/proven-receiver-stats.ts";

// `y` is assigned only under a condition, so it is presence-tracked; `x` is
// unconditional, so it is a plain slot. `p` is a never-reassigned binding
// initialized from `new P(...)`, which the S1 receiver-flow analysis proves.
const SOURCE = `
function P(a) { this.x = a; if (a > 1) { this.y = a + 1; } }
export function test() {
  var p = new P(2);
  return p.x + p.y;
}`;

async function build(): Promise<void> {
  const r = await compile(SOURCE, { fileName: "t.mjs", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.binary?.length ?? 0).toBeGreaterThan(0);
}

// Cleared rather than `delete`d: biome's `noDelete` forbids the delete form, and
// the gate reads `=== "1"`, so an empty value is indistinguishable from unset.
afterEach(() => {
  process.env.JS2WASM_PROVEN_RECEIVER_STATS = "";
  resetProvenReceiverStats();
});

describe("#3685 step 1 — proven-receiver decline census", () => {
  it("records nothing when the env var is unset", async () => {
    process.env.JS2WASM_PROVEN_RECEIVER_STATS = "";
    resetProvenReceiverStats();
    await build();
    expect(provenReceiverStats.asked).toBe(0);
    expect(provenReceiverStats.proven).toBe(0);
    expect(provenReceiverStats.inlined).toBe(0);
    expect(provenReceiverStats.reasons.size).toBe(0);
  });

  it("attributes an inlined read and a presence-tracked decline separately", async () => {
    process.env.JS2WASM_PROVEN_RECEIVER_STATS = "1";
    resetProvenReceiverStats();
    await build();

    expect(provenReceiverStats.proven).toBeGreaterThan(0);
    const keys = [...provenReceiverStats.reasons.keys()];
    // `p.x` — plain slot on a proven receiver — is inlined.
    expect(keys.some((k) => k.startsWith("ok:P.x:"))).toBe(true);
    // `p.y` — presence-tracked — is declined by that carve-out and by no other.
    expect(keys.some((k) => k.startsWith("presence:P.y:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("nofield:"))).toBe(false);

    // The aggregate counters must account for every proven receiver: an
    // inlined read or exactly one decline reason, never both and never neither.
    let declines = 0;
    for (const [reason, count] of provenReceiverStats.reasons) {
      if (!reason.startsWith("ok:") && reason !== "unproven-receiver") declines += count;
    }
    expect(provenReceiverStats.proven).toBe(provenReceiverStats.inlined + declines);
  });
});
