// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1524 — CI gate ratchet on the host-import allowlist.
 *
 * The allowlist (`src/codegen/host-import-allowlist.ts`) enumerates every
 * JS-host import we still tolerate under strict `--no-host-imports` mode.
 * The goal is to drive this list toward zero as the Wasm-native fallbacks
 * tracked by #1103, #1105, #1335, #1470-#1474 land.
 *
 * To prevent silent regression of the standalone-mode contract, this test
 * fails when the allowlist grows beyond its baseline size unless the PR
 * author signs off explicitly. Sign-off is one of:
 *
 *   - Setting the env var `ALLOWLIST_GROW=1` when running tests locally.
 *   - Including `[allowlist-grow]` in the PR description (CI parses the
 *     marker in the workflow file — see `.github/workflows/ci.yml`).
 *
 * Shrinking the allowlist is encouraged and does NOT require sign-off:
 * just update `HOST_IMPORT_ALLOWLIST_BASELINE_SIZE` in the allowlist file
 * itself (only when the baseline really is being lowered) or simply remove
 * entries (the test below treats the baseline as a one-way ceiling).
 */
import { describe, expect, it } from "vitest";
import { HOST_IMPORT_ALLOWLIST, HOST_IMPORT_ALLOWLIST_BASELINE_SIZE } from "../src/codegen/host-import-allowlist.ts";

describe("#1524 — host-import allowlist budget", () => {
  it("does not grow beyond the baseline without explicit sign-off", () => {
    const current = HOST_IMPORT_ALLOWLIST.length;
    const baseline = HOST_IMPORT_ALLOWLIST_BASELINE_SIZE;
    const allowGrow = process.env.ALLOWLIST_GROW === "1";

    if (current <= baseline) {
      // Either the same as baseline (steady state) or shrinking (good!).
      expect(current).toBeLessThanOrEqual(baseline);
      return;
    }

    if (allowGrow) {
      // Author signaled intent; print a notice but allow it through.
      // eslint-disable-next-line no-console
      console.warn(`allowlist grew from ${baseline} to ${current} entries (ALLOWLIST_GROW=1 set)`);
      return;
    }

    throw new Error(
      `Host-import allowlist grew from ${baseline} to ${current} entries.\n` +
        `Adding new JS-host imports widens the standalone-mode contract (#1524).\n` +
        `If this is intentional, either set ALLOWLIST_GROW=1 locally or include\n` +
        `'[allowlist-grow]' in the PR description so CI accepts the change, and\n` +
        `bump HOST_IMPORT_ALLOWLIST_BASELINE_SIZE in\n` +
        `src/codegen/host-import-allowlist.ts to the new count.`,
    );
  });

  it("every entry has a tracking issue or a documented rationale", () => {
    for (const entry of HOST_IMPORT_ALLOWLIST) {
      expect(entry.name, "entry must have a name").toBeTruthy();
      expect(entry.reason, `entry "${entry.name}" must explain why it's still allowed`).toBeTruthy();
      // trackingIssue === 0 is permitted (the console_* / debug-only entries
      // intentionally have no tracking issue) but it should be the exception.
      expect(typeof entry.trackingIssue).toBe("number");
    }
  });
});
