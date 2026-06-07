import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const BANNED_IMPORTS = [/^env::__extern_/, /^env::__object_/, /^env::__new_plain_object$/];

function assertNoBannedObjectImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED_IMPORTS) {
    const hits = labels.filter((label) => re.test(label));
    expect(hits, `standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}

describe("#1903 standalone __obj_find hash call remains type-correct", () => {
  it("validates and instantiates a dynamic computed-property lookup with native strings", async () => {
    const source = `
      export function run(): number {
        const warm = "abc".indexOf("b");
        const o: any = {};
        const k: any = "x";
        o[k] = 41;
        return (o[k] as number) + warm;
      }
    `;

    const r = await compile(source, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoBannedObjectImports(r.imports);
    expect(r.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);

    const wat = (r as unknown as { wat?: string }).wat ?? "";
    const objFindStart = wat.indexOf("(func $__obj_find");
    const objFindEnd = wat.indexOf("(func $__call_accessor_get", objFindStart);
    expect(objFindStart).toBeGreaterThanOrEqual(0);
    const objFind = wat.slice(objFindStart, objFindEnd);
    expect(objFind).toMatch(/local\.get 1\s+call \d+\s+local\.get 4\s+i32\.and/);

    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(42);
  });
});
