// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1320 blocker — `__sget_<field>` returns null for a numeric/boolean
 * struct field when the field is read *exclusively through the host*.
 *
 * The exported struct-field getters (`__sget_done` etc.) box numeric/boolean
 * fields via `__box_number` / `__box_boolean`. Those helpers are registered
 * lazily at in-body boxing call-sites. A module that builds a `{ value, done }`
 * record and hands it to the host (which then reads `.done` via the getter)
 * without any in-body boxing site never registered the helpers, so the getter
 * fell through to `drop; ref.null.extern` and returned null. This broke the
 * iterator-result host bridge that #1320 (Array.from) depends on.
 *
 * Fix: register the union box helpers in `emitStructFieldGetters` before any
 * getter funcIdx is computed, whenever a field bucket would emit a box call.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  return (exports.test as () => unknown)();
}

describe("#1320 — struct field getter boxes for host reads (no in-body box site)", () => {
  it("boolean `done` field read via host round-trips as boolean (not null)", async () => {
    // `r` is handed to the host as an opaque struct; the host reads `.done`
    // through `__sget_done`. No in-body boxing site exists for `done`.
    expect(
      await run(`
        export function test(): string {
          const r: { value: number; done: boolean } = { value: 42, done: true };
          const o: any = r;
          return typeof o.done;
        }
      `),
    ).toBe("boolean");
  });

  it("boolean `done` field strict-equals true via host read", async () => {
    expect(
      await run(`
        export function test(): number {
          const r: { value: number; done: boolean } = { value: 7, done: true };
          const o: any = r;
          return o.done === true ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("numeric `value` field read via host round-trips as number (not null)", async () => {
    expect(
      await run(`
        export function test(): number {
          const r: { count: number; flag: boolean } = { count: 99, flag: false };
          const o: any = r;
          return o.count;
        }
      `),
    ).toBe(99);
  });

  it("JSON.stringify of an iterator-result-shaped struct surfaces both fields", async () => {
    // JSON.stringify walks the struct via the host getters — the regression
    // path. Before the fix `done` serialized as null.
    expect(
      await run(`
        export function test(): string {
          const r: { value: number; done: boolean } = { value: 5, done: false };
          return JSON.stringify(r);
        }
      `),
    ).toBe('{"value":5,"done":false}');
  });
});
