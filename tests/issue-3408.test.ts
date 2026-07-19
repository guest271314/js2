// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3408 — retire non-atomic issue-ID entrypoints and stale collision-repair
// guidance. Static, no-network contract tests (they never reserve an id): the
// canonical creation alias and every active collision-remediation message must
// point at the ATOMIC allocator (`claim-issue.mjs --allocate`), never at the
// non-reserving predictor (`next-issue-id.mjs`), which only prints `max+1` and
// races — the dup surfaces in `merge_group`, wedging the queue. The read-only
// predictor may survive, but only under an explicitly "preview" alias name.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const pkg = JSON.parse(read("../package.json")) as { scripts: Record<string, string> };

const ALLOCATOR = "claim-issue.mjs --allocate";
const PREDICTOR = "next-issue-id.mjs";

describe("#3408 issue-ID entrypoint contract", () => {
  it("canonical `new:issue-id` runs the atomic allocator, not the predictor", () => {
    const cmd = pkg.scripts["new:issue-id"];
    expect(cmd, "new:issue-id script must exist").toBeTruthy();
    expect(cmd).toContain(ALLOCATOR);
    expect(cmd).not.toContain(PREDICTOR);
  });

  it("`new:issue-id:allocate` remains an atomic-allocator alias", () => {
    const cmd = pkg.scripts["new:issue-id:allocate"];
    expect(cmd).toContain(ALLOCATOR);
    expect(cmd).not.toContain(PREDICTOR);
  });

  it("the read-only predictor survives only under an explicit `preview` alias", () => {
    const predictorAliases = Object.entries(pkg.scripts)
      .filter(([, cmd]) => cmd.includes(PREDICTOR))
      .map(([name]) => name);
    // A named preview alias must exist so read-only visibility is preserved.
    expect(predictorAliases).toContain("preview:issue-id");
    // AND no non-preview alias may invoke the predictor.
    for (const name of predictorAliases) {
      expect(name, `predictor alias '${name}' must be labeled preview`).toMatch(/preview/i);
    }
  });

  it("merged-issue-integrity collision remediation points at the atomic allocator", () => {
    const src = read("../scripts/check-merged-issue-integrity.mjs");
    expect(src).toContain(ALLOCATOR);
    // Must NOT send users to repair a collision with the racing predictor.
    expect(src).not.toContain(PREDICTOR);
  });

  it("check-issue-ids duplicate-ID remediation points at the atomic allocator", () => {
    const src = read("../scripts/check-issue-ids.mjs");
    expect(src).toContain(ALLOCATOR);
    // The user must not be sent back to a racy `max+1` predictor.
    expect(src).not.toContain(PREDICTOR);
  });
});
