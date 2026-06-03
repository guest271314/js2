// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  getStandaloneRegExpEngine,
  hasStandaloneRegExpEngine,
  quickJsLibRegexpEngineConfig,
  STANDALONE_REGEXP_ABI,
  STANDALONE_REGEXP_ABI_VERSION,
  STANDALONE_REGEXP_ENGINE_KIND,
} from "../src/codegen/regexp-standalone.js";

describe("#682 standalone RegExp native-engine ABI scaffold", () => {
  it("keeps the engine gate closed by default", () => {
    expect(getStandaloneRegExpEngine({})).toBeNull();
    expect(getStandaloneRegExpEngine({ standaloneRegExpEngine: null })).toBeNull();
    expect(hasStandaloneRegExpEngine({})).toBe(false);
  });

  it("describes the selected QuickJS libregexp engine without enabling lowering", () => {
    const engine = quickJsLibRegexpEngineConfig();

    expect(engine.kind).toBe(STANDALONE_REGEXP_ENGINE_KIND);
    expect(engine.abiVersion).toBe(STANDALONE_REGEXP_ABI_VERSION);
    expect(engine.functions).toBe(STANDALONE_REGEXP_ABI);
    expect(hasStandaloneRegExpEngine({ standaloneRegExpEngine: engine })).toBe(true);
  });

  it("uses in-module native symbols rather than JS-host RegExp imports", () => {
    const functionNames = Object.values(STANDALONE_REGEXP_ABI).map((fn) => fn.name);

    expect(functionNames).toEqual(["__re_compile", "__re_exec", "__re_free", "__re_group_start", "__re_group_end"]);
    expect(functionNames.every((name) => name.startsWith("__re_"))).toBe(true);
    expect(functionNames.some((name) => name.startsWith("RegExp_"))).toBe(false);
  });

  it("pins the first-slice pointer-sized ABI shape", () => {
    expect(STANDALONE_REGEXP_ABI.compile.params.map((p) => p.kind)).toEqual(["i32", "i32", "i32"]);
    expect(STANDALONE_REGEXP_ABI.compile.results.map((p) => p.kind)).toEqual(["i32"]);

    expect(STANDALONE_REGEXP_ABI.exec.params.map((p) => p.kind)).toEqual(["i32", "i32", "i32", "i32"]);
    expect(STANDALONE_REGEXP_ABI.exec.results.map((p) => p.kind)).toEqual(["i32"]);

    expect(STANDALONE_REGEXP_ABI.free.params.map((p) => p.kind)).toEqual(["i32"]);
    expect(STANDALONE_REGEXP_ABI.free.results).toEqual([]);
  });
});
