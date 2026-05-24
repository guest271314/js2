---
id: 1590
title: "Improve first-5-minutes UX: Wasmtime run docs, coverage honesty, CLI run-hint, standalone I/O docs, pitch accuracy, comparison section"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: easy
reasoning_effort: medium
task_type: docs
area: docs+cli
language_feature: none
goal: developer-experience
sprint: 55
---
# #1590 — Improve js2wasm UX based on early user feedback

Several UX gaps in the "first 5 minutes with js2wasm" experience need addressing.
None are blockers, but together they shape how new users perceive the project.
Work through them in the order below, **each as a separate commit** with a clear
commit message. Do NOT bundle multiple tasks into one commit.

## Context

- Repo: js2wasm (this directory)
- Current state: ~67% test262 pass rate in a JS host, ~53% standalone
- Target audience: developers evaluating js2wasm for the first time, running
  compiled output with Wasmtime or in a JS host
- Tone for all user-facing text: factual, no marketing language, honest about
  current limitations

## Scope guard (what this is NOT)

This is purely documentation, CLI hints, and pitch language — UX polish for
current users, NOT new functionality. It is **not** about expanding test262
coverage, fixing language gaps, or implementing features (those are tracked in
their own issues).

## Tasks

### 1. Document Wasmtime runtime requirements in the README
A user running `wasmtime run out.wasm` currently gets a cryptic failure because
Wasm GC and supporting proposals are not enabled by default in stable Wasmtime.
The workaround is `-W all-proposals=y`. This should not require trial-and-error.

Acceptance criteria:
- README has a "Running compiled output" section near the top of the usage docs.
- The section lists the required Wasmtime flags for the proposals js2wasm output uses.
- A concrete example command is shown: `wasmtime -W all-proposals=y out.wasm`.
- If `all-proposals=y` is overly broad, identify the minimal subset actually
  required (e.g. `-W gc=y -W function-references=y -W exceptions=y` — VERIFY
  against the current output) and list them explicitly.
- Mention the Wasmtime minimum version known to work.
- If other standalone runtimes (WasmEdge, WAMR) work with the output, mention
  their flag equivalents; if they don't currently work, say so.

### 2. Add a "What works / What doesn't" section to the README
At 67% test262 there are real coverage gaps. New users hit them by
trial-and-error (e.g. `Array()` constructor, certain stdlib functions). Surface
the high-level shape of the gap; do not claim full coverage.

Acceptance criteria:
- New README section, honestly titled (e.g. "Current coverage and limitations").
- Lists the major language and standard-library areas with their rough state:
  solid / partial / not yet.
- Calls out known-broken patterns real users have tried, including `Array()`
  constructor invocations and any others identified during this task.
- Links to the test262 conformance report if published, or to a tracking issue.
- Does not over-promise; if something is partial, say partial.
- NOTE: requires actual auditing of which patterns work and which don't.

### 3. Compiler output should hint at how to run the result
After a successful compile, the CLI currently does not tell the user how to
execute the output. A one-line hint saves the next user the same trial-and-error.

Acceptance criteria:
- After a successful compile, the CLI prints a one-line hint such as:
  `Compiled to out.wasm. To run: wasmtime -W all-proposals=y out.wasm`
- The hint adapts to the actual output path and chosen target (standalone vs JS host).
- For JS-host targets, the hint shows the corresponding `node` or browser invocation pattern.
- The hint can be suppressed with a flag (`--quiet`) for scripted use.

### 4. Document STDIN/STDOUT handling for standalone mode
A user got `writeFileSync("/dev/stdout", ...)` to work but had no docs; STDIN
reading was not figured out at all. Document the standalone-mode I/O story.

Acceptance criteria:
- README section or `docs/standalone-io.md` covering how to read STDIN and write
  STDOUT/STDERR from compiled JS.
- Concrete copy-pasteable code examples.
- If WASI Preview 1 file descriptors (`/dev/stdin`, `/dev/stdout`, `/dev/stderr`)
  are the recommended approach, show the idiomatic JS pattern.
- If a more direct API is planned but not yet available, say so and link the tracking issue.
- Include the command line to actually run the example.

### 5. Tighten the README pitch language
The current pitch ("the three proprietary engines: V8, JavaScriptCore,
SpiderMonkey") is technically imprecise. JavaScriptCore is BSD-licensed,
SpiderMonkey is MPL-licensed — both open-source. QuickJS is a smaller
open-source alternative. The pitch loses credibility for readers who notice.

Acceptance criteria:
- The introduction paragraph is rewritten to be technically accurate while
  keeping the original intent (highlighting the gap js2wasm fills).
- Avoid the word "proprietary" for engines that are not in fact proprietary.
- If the point is about runtime footprint / engine size / sandboxing, say that
  directly instead of a license-based framing.
- Reads as honest technical positioning, not marketing.

### 6. Add a "How does this compare to..." section to the README
The compiler landscape (AssemblyScript, Javy, Porffor, StarlingMonkey + weval)
is genuinely distinct in design space. Give a sober comparison.

Acceptance criteria:
- New README section comparing js2wasm to at least: AssemblyScript, Javy,
  Porffor, StarlingMonkey + weval.
- Each comparison is 2-4 sentences, factual and respectful.
- For each: name its design point in the space, then briefly contrast with
  js2wasm's choice.
- No language framing others as worse; framing is "different trade-offs in the
  same design space".
- AssemblyScript in particular: a well-engineered project with a different goal,
  not something js2wasm replaces.
- Careful prose — do this LAST.

## Order and scope
Do these in order. Tasks 1, 3, 4 are tightly scoped and quick. Task 2 requires
auditing which patterns work. Task 5 is a careful single-paragraph rewrite.
Task 6 requires careful prose and is the last commit. Each task ends with a
working `pnpm run` of any doc build steps (if applicable) and a clean commit.

## Acceptance (overall)
- Six separate commits, one per task, in order.
- All user-facing text is factual and honest about current limitations.
- No new runtime/compiler functionality introduced.
