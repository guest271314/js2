---
id: 6704
title: "standalone: `ns.f(x)` misses the callee's real funcref when a JSDoc-optional param lowers to externref (lodash-es checksum null deref)"
status: ready
sprint: Backlog
created: 2026-09-27
updated: 2026-09-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6684, 3205, 5334]
---

# #6704 — callable-property dispatch has no arm for the callee's externref-param ABI

## Problem

After #6684 the lodash-es npm-compat `standalone-dynamic` lane gets through
module init (0 imports) and fails at the checksum call (verbatim):

```
RuntimeError: dereferencing a null pointer   (phase: checksum)
```

The trap is in the harness driver's own `__npmCompatApply`:

```js
const __pkgNs = { words, kebabCase };
function __npmCompatApply(input) {
  return Number(__pkgNs.words(input).length + __pkgNs.kebabCase(input).length);
}
```

A direct `words(input)` call answers correctly; the PROPERTY call does not.

## Reproduction (standalone, `compileProject`, no runtime-eval needed)

```js
// w.js
var re = /[a-z]+/gi;
/**
 * @param {string} [string=''] The string to inspect.
 * @param {RegExp|string} [pattern]
 * @param- {Object} [guard]
 * @returns {Array}
 */
function words(string, pattern, guard) {
  string = string + '';
  pattern = guard ? undefined : pattern;
  if (pattern === undefined) return string.match(re) || [];
  return string.match(pattern) || [];
}
export default words;

// main.mjs
import words from "./w.js";
const ns = { words };
export function run() { try { return ns.words("a b c").length; } catch (e) { return -1; } }
```

Node: `3`. Standalone: `-1` (TypeError from the dispatch ladder's terminal arm).
Removing only the `@param {string} [string='']` line makes it pass.

## Root cause (measured)

`emitRootFuncrefDispatch` (`src/codegen/expressions/calls-closures.ts`) is
handed candidates derived from the property's TS signature — all with param 0
`(ref null $AnyString)`:

```
cands: (ref null $6, externref, externref) -> {ref null $2 | externref | void | f64 | i32}
```

but the compiled `words` (and its `__fn_tramp_words_cached`) takes
`(externref, externref, externref)` — the optional-with-default JSDoc param
lowers to externref in the body. No candidate names that funcref type, so the
ladder falls to its terminal TypeError; in the full lodash graph the call ends
in a null result instead and `.length` traps.

`callablePropertyRefBridge` also refuses `ref → externref` on the no-host
lanes (only generator states pass), so even an admitted candidate could not
bridge a native-string argument to an externref formal.

## Acceptance

- The repro answers 3 under `--target standalone`.
- lodash-es `standalone-dynamic` gets past the checksum call.
