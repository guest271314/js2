// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// linked-closure-dispatch.ts — route a compiled closure to the module that can
// actually call it, inside a linked project (#3451 harness provider, #2527
// package linker).
//
// A closure the host holds is invoked through a bridge that calls one module's
// `__call_fn_N` / `__call_fn_method_N` dispatcher. Those dispatchers match a
// closure by its exact function type, so they only know the closures of their
// own module. A closure that belongs to ANOTHER module of the same project
// matches no arm, and the dispatcher's #4618 terminal hands the callee back to
// the host as `__call_function_N(fn, …)` — the arm meant for a genuine host
// function. The host wraps it with the calling module's state, which yields
// the same bridge through the same dispatcher, and the round trip repeats until
// the stack overflows.
//
// Measured on the linked test262 lane: `built-ins/RegExp/named-groups/
// duplicate-names-matchall.js` passes its validators (`v => assert.compareArray
// (v, e)`, minted in the test body) to the harness provider's
// `assert.compareIterator`, which calls `validators[i](value)`. The bridge was
// bound to the PROVIDER, the provider's `__call_fn_method_1` missed, and every
// run ended in `RangeError: Maximum call stack size exceeded`.
//
// The fix is a bounce detector plus a retry. While a bridge dispatches closure
// C through module M, a `__call_function_N(C)` issued by M itself can only be
// M's dispatcher giving C back: M's own closures are matched natively and never
// reach that import, and a body that is really running belongs to the module
// that minted it. The host import reports such a call here and returns without
// invoking anything; the bridge then retries through the other modules of the
// project and remembers the one that ran the closure. With no linked project
// live there is nothing to retry through, and callers do not enter this path.

type Exports = Record<string, Function>;

interface DispatchFrame {
  closure: object;
  exports: Exports;
  missed: boolean;
}

// Export names every module with a closure dispatcher carries. Two export views
// of one instance (the init-time funcref snapshot and the post-instantiation
// exports object) are different containers holding the SAME function objects,
// so modules are compared by function identity, never by the container.
const MODULE_IDENTITY_EXPORTS = ["__closure_arity", "__is_closure", "__call_fn_0", "__call_fn_1"] as const;

function sameModule(a: Exports, b: Exports | undefined): boolean {
  if (b === undefined) return false;
  if (a === b) return true;
  for (const name of MODULE_IDENTITY_EXPORTS) {
    const fa = a[name];
    const fb = b[name];
    if (typeof fa === "function" && typeof fb === "function") return fa === fb;
  }
  return false;
}

export interface LinkedClosureDispatch {
  /**
   * Called by the host `__call_function_N` import before it invokes `fn`.
   * True means the call is `exports`' own dispatcher bouncing the closure the
   * innermost bridge is dispatching; the import must return without calling it.
   */
  claimBounce(fn: unknown, exports: Exports | undefined): boolean;
  /**
   * Run `through(module)` for `local` (or the module already known to own
   * `closure`) and then each peer, until one does not bounce. Throws a
   * TypeError when no module of the project can call the closure.
   */
  invoke(closure: object, local: Exports, peers: readonly Exports[], through: (exports: Exports) => unknown): unknown;
  /** The bridge that dispatches `closure` through `exports`, built once by `make`. */
  bridgeFor(closure: object, exports: Exports, make: () => Function | null): Function | null;
}

export function createLinkedClosureDispatch(): LinkedClosureDispatch {
  const frames: DispatchFrame[] = [];
  const owners = new WeakMap<object, Exports>();
  const bridges = new WeakMap<object, Map<Exports, Function | null>>();

  return {
    bridgeFor(closure, exports, make) {
      let perModule = bridges.get(closure);
      if (perModule === undefined) bridges.set(closure, (perModule = new Map()));
      if (!perModule.has(exports)) perModule.set(exports, make());
      return perModule.get(exports) ?? null;
    },

    claimBounce(fn, exports) {
      const top = frames[frames.length - 1];
      if (top === undefined || top.closure !== fn || !sameModule(top.exports, exports)) return false;
      top.missed = true;
      return true;
    },

    invoke(closure, local, peers, through) {
      const known = owners.get(closure);
      const order: Exports[] = [local, ...peers];
      if (known !== undefined && known !== local && peers.includes(known)) {
        order.splice(order.indexOf(known), 1);
        order.unshift(known);
      }
      for (const exports of order) {
        const frame: DispatchFrame = { closure, exports, missed: false };
        frames.push(frame);
        let result: unknown;
        try {
          result = through(exports);
        } finally {
          frames.pop();
        }
        if (!frame.missed) {
          if (exports !== local) owners.set(closure, exports);
          return result;
        }
      }
      throw new TypeError("compiled function is not callable by any module of this linked project");
    },
  };
}
