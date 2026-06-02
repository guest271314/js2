import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLibSourceFile } from "../src/checker/index.js";
import { setDefaultEnvironment, type Environment } from "../src/env.js";
import { preloadLibFiles } from "../src/index.js";
import { ts } from "../src/ts-api.js";
import {
  createTsLibGlobalPrelude,
  discoverTypeScriptLibNames,
  readTypeScriptLibFiles,
} from "../scripts/build-standalone-cli.mjs";

const NO_NODE_ENV: Environment = { fs: null, path: null, url: null, module: null };

describe("#1775 standalone CLI bundle support", () => {
  afterEach(() => {
    setDefaultEnvironment(null);
  });

  it("discovers and serializes TypeScript lib files for the standalone prelude", () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-standalone-libs-"));
    try {
      writeFileSync(join(dir, "lib.es5.d.ts"), "interface Number {}\n");
      writeFileSync(join(dir, "lib.dom.d.ts"), "interface Document {}\n");
      writeFileSync(join(dir, "README.txt"), "ignored\n");

      const names = discoverTypeScriptLibNames(dir);
      expect(names).toEqual(["lib.dom.d.ts", "lib.es5.d.ts"]);

      const files = readTypeScriptLibFiles({ libDir: dir, names });
      expect(files["lib.es5.d.ts"]).toContain("interface Number");
      expect(files["lib.dom.d.ts"]).toContain("interface Document");

      const prelude = createTsLibGlobalPrelude({ libDir: dir, names });
      expect(prelude).toContain("createRequire");
      expect(prelude).toContain("__filename");
      expect(prelude).toContain("__dirname");
      expect(prelude).toContain("__js2wasmTsLibFiles");
      expect(prelude).toContain("lib.es5.d.ts");
      expect(prelude).toContain("interface Document");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preloadLibFiles feeds the checker without filesystem or module resolution", () => {
    setDefaultEnvironment(NO_NODE_ENV);
    const libName = "lib.js2wasm-standalone-test.d.ts";
    const source = "interface StandaloneBundleSentinel { value: string; }\n";

    preloadLibFiles({ [libName]: source });

    const sourceFile = getLibSourceFile(libName, ts.ScriptTarget.ES2022);
    expect(sourceFile?.text).toBe(source);
  });
});
