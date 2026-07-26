---
id: 3656
title: "IR: dynamic destructured parameter blocks ESLint getInactivityReasonMessage"
status: ready
created: 2026-07-26
updated: 2026-07-26
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: ir, codegen
language_feature: object-destructuring
goal: npm-library-support
sprint: 76
required_by: [1400, 2691]
es_edition: ES2015
related: [1169c, 1400, 2691, 3518, 3654]
---
# #3656 — IR lowering for an untyped JS destructured parameter

## Problem

The real ESLint package graph fails on this function from
`eslint/lib/shared/flags.js`:

```js
function getInactivityReasonMessage({ replacedBy }) {
	if (typeof replacedBy === "undefined") {
		return "This feature has been abandoned.";
	}
	if (typeof replacedBy === "string") {
		return `This flag has been renamed '${replacedBy}' to reflect its stabilization. Please use '${replacedBy}' instead.`;
	}
	return "This feature is now enabled by default.";
}
```

The fatal diagnostic is:

```text
Codegen error: IR path failed for getInactivityReasonMessage:
ir/from-ast: object destructuring source must be IrType.object or IrType.class
(got dynamic) in getInactivityReasonMessage [IR-FALLBACK]
```

## Independent reproduction

This is not merely a package-resolution cascade. On 2026-07-26 the existing CLI
failed when compiling `node_modules/eslint/lib/shared/flags.js` directly with
`--no-optimize`; it emitted the exact diagnostic above before producing Wasm.

The input is plain JavaScript under `allowJs`: JSDoc describes the parameter,
but IR sees the destructuring source as `dynamic`.

## Fix direction

Determine whether the canonical IR representation should:

1. carry the JSDoc object shape into the parameter type;
2. lower dynamic object destructuring as named dynamic property reads; or
3. return a typed `Unsupported` outcome and use an explicitly permitted legacy
   path until dynamic destructuring is represented.

Do not silently default `replacedBy` or erase the function. The returned message
must be verified by value for the missing/string/null cases.

## Acceptance criteria

- The direct real `flags.js` input compiles and emits valid Wasm.
- A reduced untyped-JS fixture covers `{ replacedBy }` with:
  omitted property, string property, and `null`.
- Runtime results match Node for all three arms.
- IR-only policy reports no invariant/fatal fallback for the function.
- `tests/issue-3656.test.ts` permanently covers the reduced untyped-JavaScript
  destructured parameter and validates its emitted Wasm.
- The full ESLint package-entry probe no longer contains the
  `getInactivityReasonMessage` diagnostic; later blockers are reported
  separately.
