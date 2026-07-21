// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type IrObservedOutcome, type IrUnsupportedCode } from "../src/index.js";
import { classifyIrFailure, evaluateIrOutcomePolicy } from "../src/ir/outcomes.js";
import { planIrCompilation } from "../src/ir/select.js";
import { ts } from "../src/ts-api.js";

type DirectSelectionOptions = NonNullable<Parameters<typeof planIrCompilation>[1]>;

function outcomes(result: Awaited<ReturnType<typeof compile>>): readonly IrObservedOutcome[] {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irOutcomes).toBeDefined();
  return result.irOutcomes ?? [];
}

function expectSelectUnsupported(
  observed: readonly IrObservedOutcome[],
  displayName: string,
  code: IrUnsupportedCode,
): void {
  const outcome = observed.find((entry) => entry.displayName === displayName);
  expect(outcome).toMatchObject({
    kind: "unsupported",
    stage: "select",
    code,
    legacyBodyEmitted: true,
    irBodyEmitted: false,
  });
  expect(outcome && evaluateIrOutcomePolicy([outcome], "hybrid").ready).toBe(true);
  expect(outcome && evaluateIrOutcomePolicy([outcome], "ir-only").ready).toBe(false);
}

function directSelection(source: string, options: DirectSelectionOptions = {}) {
  const sourceFile = ts.createSourceFile("selector-direct.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return planIrCompilation(sourceFile, {
    experimentalIR: true,
    trackFallbacks: true,
    ...options,
  });
}

function directFallbackReason(source: string, name: string = "test", options: DirectSelectionOptions = {}) {
  return directSelection(source, options).fallbacks?.find((fallback) => fallback.name === name)?.reason;
}

const PRECLAIM_CASES: ReadonlyArray<{
  readonly name: string;
  readonly code: IrUnsupportedCode;
  readonly source: string;
}> = [
  {
    name: "ambient String method",
    code: "string-method-unsupported",
    source: `export function test(): string { return "x".repeat(2); }`,
  },
  {
    name: "ambient Array method",
    code: "array-method-unsupported",
    source: `export function test(): number { const values = [1, 2]; return values.indexOf(2); }`,
  },
  {
    name: "numeric primitive method",
    code: "primitive-method-unsupported",
    source: `export function test(): number { return (1).valueOf(); }`,
  },
  {
    name: "Function.call",
    code: "function-invocation-method-unsupported",
    source: `export function test(): number {
      const inc = (value: number): number => value + 1;
      return inc.call(undefined, 1);
    }`,
  },
  {
    name: "logical value result",
    code: "logical-value-unsupported",
    source: `export function test(): number { return 0 || 42; }`,
  },
  {
    name: "template coercion",
    code: "template-substitution-unsupported",
    source: "export function test(value: number): string { return `value=${value}`; }",
  },
  {
    name: "ambient Error constructor",
    code: "error-constructor-unsupported",
    source: `export function test(): number { const error = new TypeError("bad"); return error.message.length; }`,
  },
  {
    name: "ambient TypedArray constructor",
    code: "typed-array-constructor-unsupported",
    source: `export function test(): number { const values = new Uint8Array(1); return values.length; }`,
  },
  {
    name: "direct call arity",
    code: "call-arity-unsupported",
    source: `function add(a: number, b: number): number { return a + b; }
      export function test(): number { return add(1); }`,
  },
  {
    name: "constructor arity",
    code: "constructor-arity-unsupported",
    source: `class Pair {
      a: number;
      b: number;
      constructor(a: number, b: number) { this.a = a; this.b = b; }
    }
    export function test(): number { const pair = new Pair(1); return pair.a; }`,
  },
  {
    name: "computed class member",
    code: "class-member-unsupported",
    source: `class Greeter { ["value"](): number { return 42; } }
      export function test(): number { const greeter = new Greeter(); return greeter.value(); }`,
  },
  {
    name: "nested forward call",
    code: "call-resolution-unsupported",
    source: `export function test(): number {
      function first(value: number): number { return second(value); }
      function second(value: number): number { return value + 1; }
      return first(1);
    }`,
  },
  {
    name: "class shape projection",
    code: "class-projection-unsupported",
    source: `class Builder {
      value: number;
      constructor(value: number) { this.value = value; }
      add(value: number): Builder { return new Builder(this.value + value); }
    }
    export function test(): number { return new Builder(1).add(2).value; }`,
  },
];

describe("#3529 selector preclaim capability parity", () => {
  it.each(PRECLAIM_CASES)("types $name before AST-to-IR build", async ({ code, source }) => {
    const result = await compile(source, { fileName: `${code}.ts`, trackIrOutcomes: true });
    expectSelectUnsupported(outcomes(result), "test", code);
  });

  it("uses the Date backend-capability seam on host-free targets", async () => {
    const sourceFile = ts.createSourceFile(
      "date-capability-direct.ts",
      `export function test(): number { const date = new Date(); return date.getFullYear(); }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const selection = planIrCompilation(sourceFile, {
      experimentalIR: true,
      trackFallbacks: true,
      isAmbientBinding: (node) => node.text === "Date",
      hostDateSnapshots: (expression) => ({ expression, getterCalls: new Set() }),
      supportsBackendCapability: () => false,
    });
    expect(selection.fallbacks?.find((fallback) => fallback.name === "test")?.reason).toBe(
      "date-constructor-unsupported",
    );

    const result = await compile(`export function test(): number { const date = new Date(); return date.getTime(); }`, {
      fileName: "date-capability.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });
    expectSelectUnsupported(outcomes(result), "test", "date-constructor-unsupported");
  });

  it("keeps same-named user classes and methods IR-claimable", async () => {
    const result = await compile(
      `class Custom {
        trim(): number { return 1; }
        map(): number { return 2; }
        call(): number { return 3; }
        apply(): number { return 4; }
      }
      export function canary(): number {
        const custom = new Custom();
        return custom.trim() + custom.map() + custom.call() + custom.apply();
      }`,
      { fileName: "shadow-canary.ts", trackIrOutcomes: true },
    );
    expect(outcomes(result).find((entry) => entry.displayName === "canary")).toMatchObject({
      kind: "emitted",
      stage: "patch",
      irBodyEmitted: true,
    });
  });

  it.each([
    {
      name: "sibling branch",
      source: `export function test(flag: boolean): number {
        if (flag) {
          const leaked = (value: number): number => value;
          leaked(1);
        } else {
          const leaked = 1;
          leaked();
        }
        return 0;
      }`,
    },
    {
      name: "nested block",
      source: `export function test(outer: boolean, inner: boolean): number {
        if (outer) {
          if (inner) {
            const leaked = (value: number): number => value;
            leaked(1);
          }
          if (inner) {
            const leaked = 1;
            leaked();
          }
        }
        return 0;
      }`,
    },
  ])("does not leak callable evidence across a $name boundary", ({ source }) => {
    expect(directFallbackReason(source)).toBe("call-resolution-unsupported");
  });

  it("restores projection evidence after a checker-certified callback body", () => {
    const source = `export function test(target: {}): number {
      target.addEventListener("tick", () => {
        const leaked = (value: number): number => value;
        leaked(1);
      });
      const leaked = 1;
      return leaked();
    }`;
    const selection = directSelection(source, {
      hostVoidCallbacks: (call) => {
        const argument = call.arguments[1];
        if (!argument || !ts.isArrowFunction(argument) || !ts.isBlock(argument.body)) return undefined;
        return {
          call,
          callback: argument as ts.ArrowFunction & { readonly body: ts.Block },
          captureNames: new Set(),
        };
      },
    });
    expect(selection.fallbacks?.find((fallback) => fallback.name === "test")?.reason).toBe(
      "call-resolution-unsupported",
    );
  });

  it.each([
    {
      name: "parameter",
      source: `function target(left: number, right: number): number { return left + right; }
        export function test(target: number): number { return target(1); }`,
    },
    {
      name: "local variable",
      source: `function target(left: number, right: number): number { return left + right; }
        export function test(): number { const target = 1; return target(1); }`,
    },
    {
      name: "call-return class",
      source: `class Box { value: number; constructor(value: number) { this.value = value; } }
        function make(): Box { return new Box(1); }
        export function test(make: number): number { return make().value; }`,
    },
  ])("does not fall through a $name shadow to top-level callable text", ({ source }) => {
    expect(directFallbackReason(source)).toBe("call-resolution-unsupported");
  });

  it.each([
    {
      name: "parameter",
      source: `class Box { value: number; constructor(value: number) { this.value = value; } }
        export function test(Box: number): number { const value = new Box(1); return 1; }`,
    },
    {
      name: "local variable",
      source: `class Box { value: number; constructor(value: number) { this.value = value; } }
        export function test(): number { const Box = 1; const value = new Box(1); return 1; }`,
    },
    {
      name: "hoisted nested function",
      source: `class Box { value: number; constructor(value: number) { this.value = value; } }
        export function test(): number {
          const value = new Box(1);
          function Box(input: number): number { return input; }
          return 1;
        }`,
    },
  ])("does not inherit local-class identity through a $name shadow", ({ source }) => {
    expect(directFallbackReason(source)).toBe("constructor-resolution-unsupported");
  });

  it("uses an exact missing class projection as an authoritative rejection", () => {
    const source = `class Exact { value: number; constructor(value: number) { this.value = value; } }
      export function test(): number { return new Exact(1).value; }`;
    expect(directFallbackReason(source, "test", { projectedClassShapes: new Map() })).toBe(
      "class-projection-unsupported",
    );
  });

  it("resolves inherited static methods through the class parent chain", () => {
    const selection = directSelection(`class Base { static value(input: number): number { return input; } }
      class Derived extends Base {}
      export function test(): number { return Derived.value(42); }`);
    expect(selection.funcs.has("test")).toBe(true);
  });

  it("rejects a static/instance method-name collision", () => {
    expect(
      directFallbackReason(`class Clash {
        value(): number { return 1; }
        static value(): number { return 2; }
      }
      export function test(): number { return Clash.value(); }`),
    ).toBe("class-member-unsupported");
  });

  it.each([
    {
      name: "absent property",
      source: `class Value {}
        export function test(): number { const value = new Value(); return value.missing; }`,
    },
    {
      name: "method as value",
      source: `class Value { amount(): number { return 1; } }
        export function test(): number { const value = new Value(); return value.amount; }`,
    },
    {
      name: "setter-only read",
      source: `class Value { set amount(value: number) {} }
        export function test(): number { const value = new Value(); return value.amount; }`,
    },
    {
      name: "computed accessor",
      source: `class Value {
          get ["amount"](): number { return 1; }
          set ["amount"](value: number) {}
        }
        export function test(): number { const value = new Value(); value.amount = 2; return value.amount; }`,
    },
  ])("rejects an unprojected $name before class lowering", ({ source }) => {
    expect(directFallbackReason(source)).toBe("class-member-unsupported");
  });

  it.each([
    {
      name: "field",
      source: `class Value { data: number | string; constructor() { this.data = 1; } }
        export function test(): number { const value = new Value(); return 1; }`,
    },
    {
      name: "constructor parameter",
      source: `class Value { data: number; constructor(input: number | string) { this.data = 1; } }
        export function test(): number { const value = new Value(1); return value.data; }`,
    },
    {
      name: "method parameter",
      source: `class Value { read(input: number | string): number { return 1; } }
        export function test(): number { const value = new Value(); return value.read(1); }`,
    },
    {
      name: "method return",
      source: `class Value { read(): number | string { return 1; } }
        export function test(): number { const value = new Value(); return 1; }`,
    },
  ])("rejects an unrepresentable class $name", ({ source }) => {
    expect(directFallbackReason(source)).toBe("class-projection-unsupported");
  });

  it("keeps a primitive static member claim independent of an instance-shape gap", () => {
    const selection = directSelection(`class Value {
      data: number | string;
      static answer(): number { return 42; }
    }`);
    expect(selection.classMembers?.has("Value_answer")).toBe(true);
  });

  it("preflights valid and invalid super constructor/method calls", () => {
    const valid = directSelection(`class Base {
      value: number;
      constructor(value: number) { this.value = value; }
      add(value: number): number { return this.value + value; }
    }
    class Child extends Base {
      constructor(value: number) { super(value); }
      twice(value: number): number { return super.add(value); }
    }`);
    expect(valid.classMembers?.has("Child_new")).toBe(true);
    expect(valid.classMembers?.has("Child_twice")).toBe(true);

    expect(
      directFallbackReason(
        `class Base { constructor(value: number) {} }
        class Child extends Base { constructor() { super(); } }`,
        "Child_new",
      ),
    ).toBe("constructor-arity-unsupported");
    expect(
      directFallbackReason(
        `class Base { add(value: number): number { return value; } }
        class Child extends Base { read(): number { return super.add(); } }`,
        "Child_read",
      ),
    ).toBe("call-arity-unsupported");
    expect(
      directFallbackReason(
        `class Base {}
        class Child extends Base { read(): number { return super.missing(); } }`,
        "Child_read",
      ),
    ).toBe("class-member-unsupported");
  });

  it.each([
    {
      name: "function Error",
      source: `function Error(value: string): number { return value.length; }
        export function test(): number { const error = new Error("bad"); return 1; }`,
    },
    {
      name: "module Uint8Array variable",
      source: `const Uint8Array = 1;
        export function test(): number { const bytes = new Uint8Array(1); return 1; }`,
    },
    {
      name: "function Date",
      source: `function Date(): number { return 1; }
        export function test(): number { const date = new Date(); return 1; }`,
    },
  ])("requires positive ambient identity for a $name shadow", ({ source }) => {
    expect(directFallbackReason(source, "test", { isAmbientBinding: () => false })).toBe(
      "constructor-resolution-unsupported",
    );
  });

  it("accepts certified Date snapshots when capability is absent or true", () => {
    const source = `export function test(): number { const date = new Date(); return date.getFullYear(); }`;
    for (const supportsBackendCapability of [undefined, () => true] as const) {
      const selection = directSelection(source, {
        isAmbientBinding: (node) => node.text === "Date",
        hostDateSnapshots: (expression) => ({ expression, getterCalls: new Set() }),
        ...(supportsBackendCapability ? { supportsBackendCapability } : {}),
      });
      expect(selection.funcs.has("test")).toBe(true);
    }
  });

  it("rejects a shadowed Date before consulting its snapshot certificate", () => {
    const source = `export function test(Date: number): number { const date = new Date(); return 1; }`;
    expect(
      directFallbackReason(source, "test", {
        isAmbientBinding: () => false,
        hostDateSnapshots: (expression) => ({ expression, getterCalls: new Set() }),
        supportsBackendCapability: () => true,
      }),
    ).toBe("constructor-resolution-unsupported");
  });

  it("types an unknown constructor as a direct resolution failure", () => {
    expect(directFallbackReason(`export function test(): number { const value = new Missing(); return 1; }`)).toBe(
      "constructor-resolution-unsupported",
    );
  });

  it("uses declaration identity rather than builtin constructor names", () => {
    const sourceFile = ts.createSourceFile(
      "constructor-shadows.ts",
      `class Error { value: number; constructor(value: number) { this.value = value; } }
      class Uint8Array { value: number; constructor(value: number) { this.value = value; } }
      class Date { value: number; constructor() { this.value = 5; } }
      export function canary(): number {
        const error = new Error(6);
        const bytes = new Uint8Array(7);
        const date = new Date();
        return error.value + bytes.value + date.value;
      }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const selection = planIrCompilation(sourceFile, {
      experimentalIR: true,
      trackFallbacks: true,
      isAmbientBinding: () => false,
    });
    expect(selection.funcs.has("canary")).toBe(true);
    expect(selection.fallbacks?.find((fallback) => fallback.name === "canary")).toBeUndefined();
  });

  it("keeps unknown internal throws classified as invariants", () => {
    expect(classifyIrFailure(new TypeError("malformed producer state"), "build")).toMatchObject({
      kind: "invariant",
      stage: "build",
      code: "unexpected-internal-throw",
    });
  });
});
