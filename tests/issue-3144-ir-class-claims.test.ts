// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3144 — IR class-capability slice (child of #2856): the four
// sub-capabilities that let `js/classes.ts main` claim atomically:
//
//   A  `x instanceof C` for a LOCAL class C — `class.instanceof` (runtime
//      `__tag` compare against C's tag + descendant tags, mirroring legacy
//      `compileInstanceOf`'s non-null-ref path).
//   B  static method calls `C.m(args)` — `class.static_call` (legacy statics
//      take NO `self` param); `memberKind: "static"` shape descriptors.
//   C  accessor-backed properties through instances — `recv.prop` /
//      `recv.prop = v` lower to `class.call ${recvClass}_get_/_set_<prop>`
//      (inherited accessors resolve via legacy's inherited-member key
//      propagation onto the subclass prefix).
//   D  same-typed NON-scalar ternary arms (`cond ? "a" : "b"` — string).
//
// Every positive case asserts legacy/IR observable equality, ZERO post-claim
// demotions, and (where marked) that the IR path was genuinely exercised —
// bytes must differ from the `experimentalIR: false` compile, so a silent
// legacy demote fails the test (the vacuous-pass hazard).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

const JS_STRING = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  fromCharCode: (c: number) => String.fromCharCode(c),
  cast: (s: unknown) => String(s),
  test: (v: unknown) => (typeof v === "string" ? 1 : 0),
};

interface RunResult {
  value: unknown;
  binary: Uint8Array;
  postClaim: unknown[];
  logs: string[];
}

async function compileRun(source: string, fn: string, args: unknown[], experimentalIR: boolean): Promise<RunResult> {
  const logs: string[] = [];
  const r = await compile(source, { experimentalIR, trackFallbacks: true });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  built.env.console_log_string = (v: unknown) => logs.push(String(v));
  built.env.console_log_number = (v: unknown) => logs.push(String(v));
  built.env.console_log_bool = (v: unknown) => logs.push(String(!!v));
  const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
  imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  built.setExports?.(instance.exports as Record<string, Function>);
  const f = (instance.exports as Record<string, unknown>)[fn];
  if (typeof f !== "function") throw new Error(`export ${fn} missing`);
  return {
    value: (f as (...a: unknown[]) => unknown)(...args),
    binary: r.binary,
    postClaim: r.irPostClaimErrors ?? [],
    logs,
  };
}

async function expectParity(
  source: string,
  fn: string,
  args: unknown[],
  expected: unknown,
  opts: { expectClaimed?: boolean } = {},
): Promise<void> {
  const legacy = await compileRun(source, fn, args, false);
  const ir = await compileRun(source, fn, args, true);
  expect(legacy.value, "legacy value").toStrictEqual(expected);
  expect(ir.value, "IR value matches legacy").toStrictEqual(legacy.value);
  expect(ir.postClaim, "no post-claim demotions").toStrictEqual([]);
  if (opts.expectClaimed !== false) {
    expect(
      Buffer.compare(Buffer.from(legacy.binary), Buffer.from(ir.binary)) !== 0,
      "IR path exercised (bytes differ from legacy)",
    ).toBe(true);
  }
}

const HIERARCHY = `
class Animal {
  #name: string;
  constructor(name: string) { this.#name = name; }
  get name(): string { return this.#name; }
  set name(value: string) { this.#name = value; }
  speak(): string { return this.#name + " makes a sound"; }
  static kingdom(): string { return "Animalia"; }
}
class Dog extends Animal {
  #breed: string;
  constructor(name: string, breed: string) { super(name); this.#breed = breed; }
  get breed(): string { return this.#breed; }
  static kingdom(): string { return "Animalia (canine)"; }
}
class Rock {
  weight: number;
  constructor(weight: number) { this.weight = weight; }
}
`;

describe("#3144 A — instanceof on local classes", () => {
  it("subclass instance: instanceof own class and parent class are both true", async () => {
    await expectParity(
      HIERARCHY +
        `export function main(): number {
           const d = new Dog("Rex", "Lab");
           let n = 0;
           if (d instanceof Dog) n = n + 1;
           if (d instanceof Animal) n = n + 10;
           return n;
         }`,
      "main",
      [],
      11,
    );
  });

  it("runtime tag check: Animal-typed binding holding a Dog vs a plain Animal", async () => {
    // The static type of `a` is Animal in both calls — only the runtime
    // `__tag` distinguishes them, so this pins the tag CHECK (not a fold).
    await expectParity(
      HIERARCHY +
        `function isDog(a: Animal): number {
           return a instanceof Dog ? 1 : 0;
         }
         export function main(): number {
           const plain = new Animal("Generic");
           const dog = new Dog("Rex", "Lab");
           return isDog(dog) * 10 + isDog(plain);
         }`,
      "main",
      [],
      10,
    );
  });

  it("unrelated class instance is not an instanceof match", async () => {
    await expectParity(
      HIERARCHY +
        `export function main(): number {
           const r = new Rock(3);
           return r instanceof Animal ? 1 : 0;
         }`,
      "main",
      [],
      0,
    );
  });

  it("primitive LHS folds to false (still evaluated)", async () => {
    await expectParity(
      HIERARCHY +
        `export function main(): number {
           const x = 42;
           return x instanceof Animal ? 1 : 0;
         }`,
      "main",
      [],
      0,
    );
  });

  it("shadowed class name demotes cleanly (no claim, legacy semantics kept)", async () => {
    // `Animal` is shadowed by a local — the selector rejects the shape, the
    // function stays on legacy, and behavior is unchanged. expectClaimed
    // false: bytes are ALLOWED to match legacy (full demote).
    const src =
      HIERARCHY +
      `export function main(): number {
         const d = new Dog("Rex", "Lab");
         const Animal = 1;
         return d instanceof Dog ? Animal : 0;
       }`;
    const legacy = await compileRun(src, "main", [], false);
    const ir = await compileRun(src, "main", [], true);
    expect(ir.value).toStrictEqual(legacy.value);
    expect(legacy.value).toStrictEqual(1);
  });
});

describe("#3144 B — static method calls", () => {
  it("static call on base and override on subclass dispatch by class name", async () => {
    await expectParity(
      HIERARCHY +
        `export function main(): string {
           return Animal.kingdom() + " | " + Dog.kingdom();
         }`,
      "main",
      [],
      "Animalia | Animalia (canine)",
    );
  });

  // NOTE: inherited statics called through the SUBCLASS name (`Sub.tag()`
  // where only Base declares `tag`) are a pre-existing LEGACY compile error
  // ("unexpected undefined AST node in compileExpression") — verified on
  // pristine main with `experimentalIR: false`. The whole compile aborts
  // before the IR overlay matters, so there is no IR/legacy divergence to
  // pin here; when legacy grows the capability, the IR side already resolves
  // the descriptor via the parent-chain walk.

  it("static with args participates in expressions", async () => {
    await expectParity(
      `class MathBox { static double(x: number): number { return x * 2; } }
       export function main(): number {
         return MathBox.double(4) + MathBox.double(10);
       }`,
      "main",
      [],
      28,
    );
  });
});

describe("#3144 C — accessor get/set through instances", () => {
  it("own getter, inherited getter, and setter write round-trip", async () => {
    await expectParity(
      HIERARCHY +
        `export function main(): string {
           const d = new Dog("Rex", "Lab");
           const before = d.name + "/" + d.breed;
           d.name = "Rex Jr.";
           return before + "/" + d.name;
         }`,
      "main",
      [],
      "Rex/Lab/Rex Jr.",
    );
  });

  it("numeric getter composes with arithmetic", async () => {
    await expectParity(
      `class Counter {
         #n: number;
         constructor(n: number) { this.#n = n; }
         get value(): number { return this.#n; }
         set value(v: number) { this.#n = v; }
       }
       export function main(): number {
         const c = new Counter(5);
         c.value = c.value + 37;
         return c.value;
       }`,
      "main",
      [],
      42,
    );
  });
});

describe("#3144 D — same-typed non-scalar ternary arms", () => {
  it("string-arm ternary claims and matches legacy", async () => {
    await expectParity(
      `export function main(): string {
         const n = 3;
         return (n > 2 ? "big" : "small") + "/" + (n > 5 ? "huge" : "modest");
       }`,
      "main",
      [],
      "big/modest",
    );
  });
});

describe("#3144 E — whole-corpus classes.ts e2e", () => {
  it("playground classes.ts main: IR console output identical to legacy", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "website", "playground", "examples", "js", "classes.ts"), "utf-8");
    const legacy = await compileRun(src, "main", [], false);
    const ir = await compileRun(src, "main", [], true);
    expect(ir.postClaim, "no post-claim demotions").toStrictEqual([]);
    expect(ir.logs, "console output parity").toStrictEqual(legacy.logs);
    expect(legacy.logs.length).toBe(9);
    expect(
      Buffer.compare(Buffer.from(legacy.binary), Buffer.from(ir.binary)) !== 0,
      "IR path exercised on classes.ts",
    ).toBe(true);
  });
});
