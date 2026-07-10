// #2978 — `for await` over a sync iterator yielding rejected promises must not
// loop forever (measured ~3 GB JS-heap OOM pre-fix), and #2934-3b — a VOID user
// `return()` method must not underflow the IteratorClose `drop` (invalid Wasm).
//
// The two fixes are a hard pairing (issue #2978 "PAIRING CONSTRAINT"): the
// drop-arity validity fix alone would have EXPOSED the OOM loop to CI shard
// workers, so this suite pins them together:
//   - Part A: void-`return()` for-await module is VALID Wasm on every lane.
//   - Part B (carrier lanes — wasi today, standalone under the #2980 widen):
//     a REJECTED `$Promise` element closes the sync iterator exactly once and
//     rethrows the reason into the user `catch` (§27.1.4.4
//     AsyncFromSyncIteratorContinuation + §7.4.6 IteratorClose).
//   - Part B (host-promise lanes — gc-host, standalone carrier-off): promise
//     settlement is not synchronously observable, so a bounded step cap
//     converts the would-be-infinite drive into a loud TypeError that still
//     runs IteratorClose exactly once. Bounded memory, no CI worker OOM.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** The issue's canonical repro (module-level state, void return()). */
const REPRO = `
var returnCount = 0;
var caught = false;
var reasonOk = 0;
const syncIterator = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: Promise.reject("reject"), done: false };
      },
      return() {
        returnCount += 1;
      },
    };
  },
};
async function t() {
  try {
    for await (let _ of syncIterator as any);
  } catch (e) {
    caught = true;
    if (e === "reject") reasonOk = 1;
  }
}
t();
export function readCaught(): number { return caught ? 1 : 0; }
export function readReturnCount(): number { return returnCount; }
export function readReasonOk(): number { return reasonOk; }
`;

interface Ex {
  readCaught(): number;
  readReturnCount(): number;
  readReasonOk(): number;
}

describe("#2978/#2934-3b: for-await over rejected-promise sync iterator", () => {
  it("Part A: void return() module is VALID Wasm on all three lanes", async () => {
    for (const opts of [{}, { target: "standalone" }, { target: "wasi" }] as const) {
      const r = await compile(REPRO, { fileName: "t.ts", ...opts });
      expect(r.success, `lane ${JSON.stringify(opts)}: ${r.errors?.[0]?.message}`).toBe(true);
      expect(WebAssembly.validate(r.binary), `lane ${JSON.stringify(opts)} must validate`).toBe(true);
    }
  });

  it("wasi (native carrier): rejection closes the iterator once and lands in catch", async () => {
    const r = await compile(REPRO, { fileName: "t.ts", target: "wasi" });
    expect(r.success).toBe(true);
    // Host-free on the carrier lane.
    expect((r.imports ?? []).length).toBe(0);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as unknown as Ex;
    expect(ex.readCaught()).toBe(1);
    expect(ex.readReturnCount()).toBe(1); // exactly once — not 0, not 2
    expect(ex.readReasonOk()).toBe(1); // e === "reject"
  });

  it("standalone (native carrier since the #2980 flip): rejection lands in catch, close exactly once", async () => {
    // Pre-flip this lane was carrier-OFF: the rejected promise was an opaque
    // host value, the bounded step cap aborted with its own TypeError, and
    // this test asserted `readReasonOk() === 0`. The 2026-07-10 #2980 carrier
    // widen puts standalone on the native `$Promise` lane (this module has no
    // async generator, so `widenAsyncGenFallback` does not fire), which
    // upgrades the shape to the FULL spec semantics — identical to the wasi
    // case above: the ORIGINAL rejection reason reaches the user catch and
    // IteratorClose runs exactly once. Still bounded wall-clock (pre-#2978
    // this OOM'd at ~3 GB / ~14 s).
    const r = await compile(REPRO, { fileName: "t.ts", target: "standalone" });
    expect(r.success).toBe(true);
    const t0 = Date.now();
    const { instance } = await WebAssembly.instantiate(
      r.binary,
      (r as { importObject?: WebAssembly.Imports }).importObject ?? {},
    );
    const elapsed = Date.now() - t0;
    const ex = instance.exports as unknown as Ex;
    expect(ex.readCaught()).toBe(1);
    expect(ex.readReturnCount()).toBe(1);
    expect(ex.readReasonOk()).toBe(1); // e === "reject" — the real reason, not the cap TypeError
    expect(elapsed).toBeLessThan(10_000);
  });

  it("normal completion unaffected: sync iterable of plain values drains with NO spurious return()", async () => {
    const src = `
var returnCount = 0;
var sum = 0;
const it3 = {
  [Symbol.iterator]() {
    let i = 0;
    return {
      next() {
        i += 1;
        return { value: i, done: i > 3 };
      },
      return() {
        returnCount += 1;
      },
    };
  },
};
async function t() {
  for await (const x of it3 as any) {
    sum = sum + (x as number);
  }
}
t();
export function readSum(): number { return sum; }
export function readReturnCount(): number { return returnCount; }
`;
    for (const opts of [{}, { target: "standalone" }, { target: "wasi" }] as const) {
      const r = await compile(src, { fileName: "t.ts", ...opts });
      expect(r.success, `lane ${JSON.stringify(opts)}: ${r.errors?.[0]?.message}`).toBe(true);
      const { instance } = await WebAssembly.instantiate(
        r.binary,
        (r as { importObject?: WebAssembly.Imports }).importObject ?? {},
      );
      const ex = instance.exports as unknown as { readSum(): number; readReturnCount(): number };
      expect(ex.readSum(), `lane ${JSON.stringify(opts)} sum`).toBe(6); // values 1,2,3 delivered; done at i=4
      expect(ex.readReturnCount(), `lane ${JSON.stringify(opts)} no spurious close`).toBe(0);
    }
  });

  it("break still closes exactly once (existing #851 semantics preserved)", async () => {
    const src = `
var returnCount = 0;
var got = 0;
const inf = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 7, done: false };
      },
      return() {
        returnCount += 1;
      },
    };
  },
};
async function t() {
  for await (const x of inf as any) {
    got = x as number;
    break;
  }
}
t();
export function readGot(): number { return got; }
export function readReturnCount(): number { return returnCount; }
`;
    for (const opts of [{}, { target: "standalone" }, { target: "wasi" }] as const) {
      const r = await compile(src, { fileName: "t.ts", ...opts });
      expect(r.success, `lane ${JSON.stringify(opts)}: ${r.errors?.[0]?.message}`).toBe(true);
      const { instance } = await WebAssembly.instantiate(
        r.binary,
        (r as { importObject?: WebAssembly.Imports }).importObject ?? {},
      );
      const ex = instance.exports as unknown as { readGot(): number; readReturnCount(): number };
      expect(ex.readGot(), `lane ${JSON.stringify(opts)}`).toBe(7);
      expect(ex.readReturnCount(), `lane ${JSON.stringify(opts)} close-on-break once`).toBe(1);
    }
  });

  it("wasi: fulfilled promise elements unwrap (Await(v) one level)", async () => {
    const src = `
var sum = 0;
const it2 = {
  [Symbol.iterator]() {
    let i = 0;
    return {
      next() {
        i += 1;
        return { value: Promise.resolve(i * 10), done: i > 2 };
      },
    };
  },
};
async function t() {
  for await (const x of it2 as any) {
    sum = sum + (x as number);
  }
}
t();
export function readSum(): number { return sum; }
`;
    const r = await compile(src, { fileName: "t.ts", target: "wasi" });
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // values 10, 20 delivered (done at i=3) — unwrapped numbers, not $Promise refs
    expect((instance.exports as unknown as { readSum(): number }).readSum()).toBe(30);
  });

  it("wasi: throwing return() during rejection close is suppressed — original rejection wins (§7.4.6)", async () => {
    const src = `
var returnCount = 0;
var caught = false;
var reasonOk = 0;
const bad = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: Promise.reject("reject"), done: false };
      },
      return() {
        returnCount += 1;
        throw "close-error";
      },
    };
  },
};
async function t() {
  try {
    for await (let _ of bad as any);
  } catch (e) {
    caught = true;
    if (e === "reject") reasonOk = 1;
  }
}
t();
export function readCaught(): number { return caught ? 1 : 0; }
export function readReturnCount(): number { return returnCount; }
export function readReasonOk(): number { return reasonOk; }
`;
    const r = await compile(src, { fileName: "t.ts", target: "wasi" });
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    // The user `throw` statement pulls in the wasi exception-render machinery —
    // shim the two wasi_snapshot_preview1 entries it declares.
    const { instance } = await WebAssembly.instantiate(r.binary, {
      ...((r as { importObject?: WebAssembly.Imports }).importObject ?? {}),
      wasi_snapshot_preview1: { fd_write: () => 0, proc_exit: () => {} },
    });
    const ex = instance.exports as unknown as Ex;
    expect(ex.readCaught()).toBe(1);
    expect(ex.readReturnCount()).toBe(1);
    expect(ex.readReasonOk()).toBe(1); // the ORIGINAL rejection, not "close-error"
  });

  it("plain for..of (no await) is byte-unaffected by the cap/unwrap machinery", async () => {
    const src = `
const it3 = {
  [Symbol.iterator]() {
    let i = 0;
    return {
      next() {
        i += 1;
        return { value: i, done: i > 3 };
      },
    };
  },
};
export function test(): number {
  let sum = 0;
  for (const x of it3 as any) {
    sum = sum + (x as number);
  }
  return sum;
}
`;
    const r = await compile(src, { fileName: "t.ts", target: "standalone" });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as unknown as { test(): number }).test()).toBe(6);
  });
});
