// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildSelfHostedIr, type SelfHostedFuncDef } from "../src/codegen/stdlib-selfhost.js";
import { irVal } from "../src/ir/nodes.js";

const F64 = irVal({ kind: "f64" });

describe("#3520 self-host cache eligibility", () => {
  it("checks the context-bound resolver guard before reading an identity-free cached template", () => {
    const def: SelfHostedFuncDef = {
      name: "__issue3520_context_free",
      source: "export function __issue3520_context_free(value: number): number { return value + 1; }",
      paramTypes: [F64],
      returnType: F64,
      calleeTypes: new Map(),
      memoKey: "issue-3520/context-free/v1",
    };

    const cached = buildSelfHostedIr(def);
    expect(buildSelfHostedIr(def)).toBe(cached);
    expect(() => buildSelfHostedIr(def, {})).toThrow("sets memoKey but was built with a ctx-bound resolver");
  });

  it("never shares a context-relative type index through the process cache", () => {
    const makeDef = (typeIdx: number): SelfHostedFuncDef => ({
      name: "__issue3520_context_bound",
      source: "export function __issue3520_context_bound(value: unknown): unknown { return value; }",
      paramTypes: [irVal({ kind: "ref_null", typeIdx })],
      returnType: irVal({ kind: "ref_null", typeIdx }),
      calleeTypes: new Map(),
    });

    const first = buildSelfHostedIr(makeDef(41));
    const second = buildSelfHostedIr(makeDef(99));

    expect(first).not.toBe(second);
    expect(first.params[0]?.type).toEqual(irVal({ kind: "ref_null", typeIdx: 41 }));
    expect(second.params[0]?.type).toEqual(irVal({ kind: "ref_null", typeIdx: 99 }));
    expect(first.resultTypes).toEqual([irVal({ kind: "ref_null", typeIdx: 41 })]);
    expect(second.resultTypes).toEqual([irVal({ kind: "ref_null", typeIdx: 99 })]);
  });
});
