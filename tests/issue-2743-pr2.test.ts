import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { runTest262File } from "./test262-runner.js";

/**
 * #2743 PR-2 — `arguments` as an ordinary Object (groups (a) + (b)).
 *
 * The compiled `arguments` object is a vec (array-like) struct. Spec §10.4.4
 * makes it an *ordinary Object*: its `[[Prototype]]` is %Object.prototype%, its
 * `.constructor` is %Object%, and `arguments[Symbol.iterator]` is
 * %Array.prototype.values%. PR-1 (#2184) handled group (c) — unmapped arguments
 * for non-simple parameter lists. PR-2 adds:
 *
 *   (a) [[Prototype]] = Object.prototype + `.constructor` = Object + a vec-aware
 *       `hasOwnProperty`. Codegen intercepts the `arguments` identifier in
 *       `Object.getPrototypeOf(arguments)` and `arguments.constructor[.prototype]`
 *       and emits the compiler's OWN `Object` / `Object.prototype` value-read so
 *       the identity matches a plain object (the host intrinsics are a DIFFERENT
 *       representation than the compiler's $NativeProto-backed Object). A
 *       host-side `__register_arguments` WeakSet marker + `__getPrototypeOf` /
 *       `__hasOwnProperty` hooks cover the runtime-routed reads.
 *   (b) `arguments[Symbol.iterator]` / `[][Symbol.iterator]` → the SAME
 *       %Array.prototype.values% intrinsic. The vec computed-get otherwise
 *       coerces the Symbol key to a numeric index (ToNumber → "Cannot convert a
 *       Symbol value to a number"); the vec-struct element-access path now routes
 *       a `Symbol.iterator` key to `__array_proto_values`.
 *
 * `__register_arguments` is a NEW host import — it is registered + flushed via
 * the late-import machinery (which shifts function indices and walks the current
 * + prior function bodies), so these tests both COMPILE and RUN: an
 * "invalid Wasm binary" at instantiation would signal a function-index desync.
 *
 * Out of scope (documented gaps): `arguments.callee` identity (S10.6_A4),
 * writable/deletable `length`/`callee` data props (S10.6_A5_T3/T4, A3_T4) — they
 * need vec property write/delete semantics; mapped/* exotic descriptors (#1726).
 */

const TEST262 = "/workspace/.claude/worktrees/agent-a9e45f6c258c968d1/test262";
const ROOT = `${TEST262}/test/language/arguments-object`;

// (a) ordinary-Object semantics + (b) @@iterator.
const shouldPass = [
  "10.6-5-1.js", // getPrototypeOf(arguments) === Object.prototype
  "S10.6_A2.js", // arguments.constructor.prototype === Object.prototype
  "S10.6_A3_T1.js", // arguments.hasOwnProperty("callee") === true
  "S10.6_A5_T1.js", // arguments.hasOwnProperty("length") === true
  "unmapped/Symbol.iterator.js", // arguments[Symbol.iterator] === [][Symbol.iterator]
  "mapped/Symbol.iterator.js",
];

const maybe = existsSync(TEST262) ? describe : describe.skip;

maybe("#2743 PR-2 — arguments ordinary-Object semantics (a) + @@iterator (b)", () => {
  for (const rel of shouldPass) {
    it(rel, async () => {
      const r = await runTest262File(`${ROOT}/${rel}`, "language");
      expect(r.status, `reason: ${(r as any).reason ?? (r as any).error ?? ""}`).toBe("pass");
    });
  }
});
