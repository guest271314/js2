// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2906 slice 3c — try/CATCH-around-await on the host-free async drive machine.
//
// `try { …await… } catch (e) { … }` could not be driven: `planLinearAwaits`
// rejects any try with a catch clause, so the shape fell to the AG0 one-level
// unwrap and the catch never observed a rejection (the rejected `$Promise`'s
// reason field was read as the VALUE — silently wrong). 3c adds:
//   - a CFG producer (`planTryCatchCfg`) lowering the bounded shape — pre
//     statements, one top-level try/catch (no finally), post statements, each
//     chunk linear-canonical with awaits allowed (including INSIDE the catch);
//   - `AsyncHandlerRegion.catchState`: the region's catch chain entry;
//   - the ROUTED dispatcher: `block { loop { try { chain } catch { route } } }`
//     — an abrupt completion raised while the region is active (a rejected
//     in-try await re-thrown by the resume prelude, or a synchronous throw in
//     an in-try lead) becomes a STATE TRANSITION into the catch chain (reason
//     bound to the catch param local + spill, MODE consumed, `br` re-dispatch).
//     A throw with no active region falls to the pre-3c reject tail; plans
//     without a catchState keep the pre-3c dispatcher BYTE-IDENTICALLY.
//
// Native (wasi/standalone-carrier) drive lane only — the host lane keeps its
// current shapes byte-identically (`allowTryCatch: !info.host`).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

type Target = "wasi" | "standalone";

/** Compile + instantiate; kick the async fn, drain microtasks, read the side channel. */
async function driveCap(src: string, target: Target = "wasi"): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // Some throw paths pull the wasi fd_write error sink — stub it; no JS host.
  const imports = { wasi_snapshot_preview1: { fd_write: () => 0, proc_exit: () => {} } };
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const ex = instance.exports as {
    kick: () => number;
    getCap: () => number;
    __drain_microtasks?: () => void;
  };
  ex.kick();
  ex.__drain_microtasks?.();
  return ex.getCap();
}

describe("#2906 3c — try/catch-around-await drive (wasi lane)", () => {
  it("verify-first: a rejected in-try await enters the catch with the reason bound", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.reject(new Error("boom"));
    cap = (x as number) + 1000;
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(42);
  });

  it("a fulfilled in-try await takes the try continuation (catch not entered)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.resolve(7);
    cap = (x as number) + 1000;
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1007);
  });

  it("pre-try await delivers, rejection on the 2nd (in-try) await routes", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  const a = await Promise.resolve(3);
  try {
    const b = await Promise.reject(new Error("y"));
    cap = (a as number) + (b as number);
  } catch (e) {
    cap = (a as number) + 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(45);
  });

  it("the catch body may itself await (catch chain suspends + resumes)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("z"));
    cap = 1;
  } catch (e) {
    const r = await Promise.resolve(8);
    cap = 42 + (r as number);
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(50);
  });

  it("post statements after the try run on the catch path too (join state)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("q"));
    cap = 1;
  } catch (e) {
    cap = 42;
  }
  const t = await Promise.resolve(100);
  cap = cap + (t as number);
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(142);
  });

  it("a SYNCHRONOUS throw in an in-try lead routes to the catch (not reject)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
function boom(): number { throw new Error("sync"); }
async function f(): Promise<void> {
  try {
    const a = await Promise.resolve(1);
    cap = boom() + (a as number);
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(42);
  });

  it("a throw INSIDE the catch body rejects the result promise (no route loop)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("a"));
  } catch (e) {
    cap = 5;
    throw new Error("b");
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(5);
  });

  it("catch WITHOUT a binding routes (reason dropped)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("nobind"));
    cap = 1;
  } catch {
    cap = 77;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(77);
  });

  it("locals crossing the try + a post await survive (widened frame spills)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  let acc: number = 5;
  try {
    const x = await Promise.resolve(10);
    acc = acc + (x as number);
  } catch (e) {
    acc = -1;
  }
  const y = await Promise.resolve(100);
  cap = acc + (y as number);
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(115);
  });

  it("GENUINELY-PENDING rejection routes on resume (reject step adapter → prelude re-throw → route)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.resolve(1).then((v: number) => { throw new Error("later"); });
    cap = (x as number) + 1000;
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(42);
  });

  it("GENUINELY-PENDING fulfil keeps the try continuation", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.resolve(1).then((v: number) => v + 4);
    cap = (x as number) + 1000;
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1005);
  });

  it("pending rejection + await inside the catch after routing", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.resolve(1).then((v: number) => { throw new Error("later"); });
    cap = 1;
  } catch (e) {
    const r = await Promise.resolve(1).then((v: number) => v + 7);
    cap = 42 + (r as number);
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(50);
  });
});

describe("#2906 3c — try/catch-around-await drive (standalone carrier lane)", () => {
  it("the core rejection→catch case drives on standalone too", async () => {
    expect(
      await driveCap(
        `let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.reject(new Error("boom"));
    cap = (x as number) + 1000;
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`,
        "standalone",
      ),
    ).toBe(42);
  });

  it("catch-with-await + post-join drives on standalone", async () => {
    expect(
      await driveCap(
        `let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("z"));
    cap = 1;
  } catch (e) {
    const r = await Promise.resolve(8);
    cap = 42 + (r as number);
  }
  const t = await Promise.resolve(100);
  cap = cap + (t as number);
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`,
        "standalone",
      ),
    ).toBe(150);
  });
});
