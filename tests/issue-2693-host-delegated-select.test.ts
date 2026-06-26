// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2693 milestone wiring confirmation — DUAL host-delegation seam.
//
// The real eslint Linter.verify host-delegates BOTH (a) PARSE (espree) and
// (b) SELECTOR MATCHING (esquery — its native compile is blocked, #2700), while
// the COMPILED wasm runs the lint orchestration (rules / disable-directives /
// messages / code-path). This test proves that exact seam end to end in a
// compiled `Linter`: the wasm calls host espree (tokenize) AND host esquery
// (parse + matches) — using the REAL Node packages on the host — and produces a
// correct `semi`-rule diagnostic.
//
// This is the architecture the full real-eslint run uses (gated only on #2688
// for apply-disable-directives + the bounded-compile setup-eslint-deps fixtures).
// Here we confirm the host seam is sound with the real parsers, independent of
// those gates.

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

// Compiled Linter: host-delegates parse (espree) AND select (esquery).
const LINTER_SRC = `
declare function __host_is_statement(code: string): boolean;   // esquery.matches over espree AST
declare function __host_last_is_semi(code: string): boolean;   // espree tokenize: last token === ';'
declare function __host_last_line(code: string): number;
declare function __host_last_col(code: string): number;

class Linter {
  verify(code: string): string {
    // host esquery selects whether the root is a statement that requires a
    // terminating ';'; host espree supplies the token position. The rule logic
    // + message assembly run in wasm.
    if (__host_is_statement(code) && !__host_last_is_semi(code)) {
      return "Missing semicolon. (" + __host_last_line(code) + ":" + __host_last_col(code) + ")";
    }
    return "";
  }
}
export function verify(code: string): string { return new Linter().verify(code); }
`;

describe("#2693 — dual host-delegation seam (host espree parse + host esquery select)", () => {
  it("a compiled Linter calls host espree + host esquery and emits the semi diagnostic", async () => {
    // Resolve the REAL espree + esquery from eslint's (pnpm) dep tree via the
    // realpath'd entry, mirroring how the full integration resolves them.
    let espree: typeof import("espree");
    let esquery: any;
    try {
      const real = realpathSync("/workspace/node_modules/eslint/lib/linter/linter.js");
      const req = createRequire(real);
      espree = req("espree");
      esquery = req("esquery");
      // esquery ships as a namespace or default-export bundle.
      if (typeof esquery.matches !== "function" && esquery.default) esquery = esquery.default;
    } catch {
      // eslint dep tree not present in this environment — skip (the #2693
      // milestone test pins the architecture without the real deps).
      return;
    }

    const r = await compile(LINTER_SRC, { fileName: "linter.ts" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);

    const STMT_SELECTOR = esquery.parse("VariableDeclaration, ExpressionStatement");
    const tokensOf = (code: string) => espree.tokenize(code, { ecmaVersion: 2022, loc: true });

    const io = r.importObject as unknown as { env: Record<string, unknown>; __setExports?: (e: unknown) => void };
    io.env.__host_is_statement = (code: string): number => {
      try {
        const ast = espree.parse(code, { ecmaVersion: 2022, loc: true });
        const first = (ast as any).body?.[0];
        return first && esquery.matches(first, STMT_SELECTOR, []) ? 1 : 0;
      } catch {
        return 0;
      }
    };
    io.env.__host_last_is_semi = (code: string): number => {
      const t = tokensOf(code);
      const last = t[t.length - 1];
      return last && last.value === ";" ? 1 : 0;
    };
    io.env.__host_last_line = (code: string): number => {
      const t = tokensOf(code);
      const last = t[t.length - 1];
      return last?.loc?.start?.line ?? 0;
    };
    io.env.__host_last_col = (code: string): number => {
      const t = tokensOf(code);
      const last = t[t.length - 1];
      return last ? (last.loc?.start?.column ?? 0) + 1 : 0;
    };

    const { instance } = await WebAssembly.instantiate(r.binary, io as unknown as WebAssembly.Imports);
    io.__setExports?.(instance.exports);
    const verify = instance.exports.verify as (c: string) => string;

    // Real espree tokenization + real esquery selector matching, wasm rule logic.
    expect(verify("var x = 1")).toBe("Missing semicolon. (1:9)");
    expect(verify("var x = 1;")).toBe("");
    expect(verify("foo()")).toBe("Missing semicolon. (1:5)");
    expect(verify("foo();")).toBe("");
  });
});
