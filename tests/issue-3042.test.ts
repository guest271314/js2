import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// #3042 — Object.defineProperty attribute round-trip fidelity.
//
// A value-less data descriptor (no `value`/`get`/`set`, e.g. `{ enumerable:
// false }`) creates a data property whose `[[Value]]` defaults to `undefined`
// (ES §10.1.6.3). On a struct-typed receiver (`var obj = {}`, widened to carry
// the defineProperty-introduced field) that define lowers to a struct no-op, so
// the field kept its creation-time default. That default was `ref.null.extern`
// — reading back as `null`, not `undefined` — which broke the test262
// `verifyProperty` value check across ~14 `built-ins/Object/define{Property,
// Properties}` rows. The widened-field default now uses JS `undefined`
// (`emitUndefined`), matching the main object-literal path.
describe("#3042 defineProperty attribute round-trip (value-less default → undefined)", () => {
  it("value-less descriptor: obj.foo reads back as undefined, not null", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = {};
        Object.defineProperty(obj, "foo", { enumerable: false });
        var v: any = (obj as any).foo;
        return v === undefined ? 1 : (v === null ? 2 : 3);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("double value-less descriptor (15.2.3.6-4-79 shape): still undefined", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = {};
        Object.defineProperty(obj, "foo", { enumerable: false });
        Object.defineProperty(obj, "foo", { enumerable: false });
        var v: any = (obj as any).foo;
        return v === undefined ? 1 : (v === null ? 2 : 3);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("value-less writable:false descriptor: undefined default", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = {};
        Object.defineProperty(obj, "bar", { writable: false });
        var v: any = (obj as any).bar;
        return v === undefined ? 1 : (v === null ? 2 : 3);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("value-less define after a value-ful define preserves the value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = {};
        Object.defineProperty(obj, "foo", { value: 7 });
        Object.defineProperty(obj, "foo", { enumerable: false });
        var v: any = (obj as any).foo;
        return v === 7 ? 7 : (v === undefined ? 0 : -1);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("never-defined widened field reads as undefined (missing-property semantics)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = {};
        Object.defineProperty(obj, "a", { enumerable: false });
        // 'b' is a sibling widened field never given a value
        Object.defineProperty(obj, "b", { enumerable: false });
        var va: any = (obj as any).a;
        var vb: any = (obj as any).b;
        return (va === undefined && vb === undefined) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
