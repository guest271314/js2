# #3259 — Bloat quick-wins report (knip + jscpd)

_Run 2026-07-14 on `origin/main` @ 4bc8763166 (post sprint-71 freeze)._

**Bottom line: there is no cheap automated −LOC left in `src/codegen/`.**
Both halves of the quick-win came up empty. The genuine subtraction lever is the
self-host epic (#3256–#3258) — not tooling. This report records _why_ so the
finding isn't re-litigated.

## Half 1 — dead-export sweep (knip substitute)

knip is **not** wired into the repo (the #3259 premise was slightly off — #3090
Phase 2b used a purpose-built call-graph reachability audit, not knip). The
equivalent live gate is `pnpm run check:dead-exports`
(`scripts/audit-legacy-reachability.mjs --check`), baseline in
`scripts/dead-export-baseline.json`.

Current state: **gate OK, 16 known-unreferenced top-level functions.** These are
"unreferenced from production code" — but the audit's survivor roots are `src/`
_outside_ `src/codegen/` and **exclude `tests/`**. Grepping each of the 16
across `src/ + tests/`:

| Candidate | Pinned by |
|---|---|
| `builtin-tags.ts#getBuiltinParent` | `tests/issue-1325.test.ts` |
| `context/speculative.ts#withSpeculativeCompile` | `tests/issue-1919-speculative-compile.test.ts` |
| `fallback-telemetry.ts#{fallbackCountsToJson,totalFallbackHits}` | `tests/issue-2089-fallback-telemetry.test.ts` |
| `index.ts#{getPseudoExternClassInfo,resolveMethodDispatchTarget}` | `tests/issue-1238.test.ts` |
| `regexp-standalone.ts#quickJsLibRegexpEngineConfig` | `tests/issue-682-regexp-standalone-abi.test.ts` |
| `value-tags.ts#{emitIsUndefF64,jsStaticType,pushUndefF64}` | `tests/issue-2104-value-tags.test.ts` |
| `regex/vm.ts#{search,runAt,asciiFold,classMatch,isLineTerminator,isWordChar}` | `tests/issue-2091-regex-step-cap-throw.test.ts`, `tests/regex-bytecode.test.ts` |

**Every one of the 16 is pinned by a unit test → zero safe deletions.** #3090
Phase 2b already removed the truly-dead ones; what remains is all test-covered.
Two judgment-call clusters remain (owner sign-off, not a quick-win):

- **Test-only internal helpers** (getBuiltinParent, the value-tags trio, the
  telemetry pair, speculative, pseudo-extern/dispatch, quickJsLib config) —
  exist only to unit-test compiler internals. Deleting them means deleting the
  tests that lock those internals' behavior. Probably keep.
- **A whole test-only reference module**: `src/codegen/regex/vm.ts` (299 LOC).
  Production (`native-regex.ts`) imports only the `REGEX_STEP_CAP` constant; the
  entire bytecode VM (`search`/`runAt`/`asciiFold`/`classMatch`/…, ~275 LOC) is
  a reference/oracle implementation kept alive solely by its own two tests. This
  is the single largest deletable block **if** the team decides the VM oracle
  tests are redundant with `native-regex`'s own coverage — a deliberate call,
  filed as a follow-up note, not deleted here.

## Half 2 — jscpd copy-paste scan of `src/codegen/`

`npx jscpd@4 src/codegen --min-lines 15 --min-tokens 100 --max-size 10mb`.

**Result: 11 clones, 224 duplicated lines = 0.64% of the analyzed code.**
Negligible, and all small (16–35 line blocks), all local (same-file or
sibling-file). Full list:

```
logical-ops.ts   [118-141] <-> [42-65]     24L   (dup guard arm)
extern.ts        [345-372] <-> [246-273]   28L
eval-inline.ts   [909-924] <-> [551-567]   16L
calls-optional.ts[139-157] <-> [116-134]   19L
wellformed-native.ts [248-282] <-> [99-132] 35L  (largest)
wellformed-native.ts [345-361] <-> [172-188] 17L
set-algebra.ts   [203-220] <-> [177-194]   18L
set-algebra.ts   [317-332] <-> [264-279]   16L
json-runtime.ts  [655-676] <-> [597-618]   22L
json-runtime.ts  [765-787] <-> [654-676]   23L
escape-native.ts [32-48] <-> wellformed-native.ts [32-42] 17L
```

**Critical caveat — jscpd is blind to the god-files.** It analyzed only **105 of
166** `src/codegen/` files (34,831 of 251,490 LOC ≈ **14%**). Its tokenizer
silently drops files above ~1k lines _regardless of_ `--max-size` — so it skipped
**every** god-file: `calls.ts` (19.2k), `index.ts` (15.8k), `object-runtime.ts`
(11.6k), `array-methods.ts` (10.2k), `native-strings.ts` (7.5k). The largest
file it actually read was `json-runtime.ts` at 955 LOC. jscpd therefore reports
"clean" on the tidy 14% while being unable to see the 86% where the hand-emitted
`Instr[]` duplication actually lives.

**→ jscpd cannot measure the bloat that matters.** The duplicated `Instr[]`
sequences inside the god-files are exactly the material the self-host conversion
(#3256 strings / #3257 arrays / #3258 objects) deletes wholesale. There is no
byte-inert helper-extraction win available in the readable slice that would move
the needle.

## Recommendation

- **Do not** delete any of the 16 test-pinned exports as part of this quick-win.
- **Optional follow-up** (needs owner call): retire `regex/vm.ts` + its 2 tests
  if the `native-regex` path's own tests already cover the behavior (~299 LOC).
- **The real lever is #3256–#3258.** Sequence them per
  `plan/self-hosting-scale-up.md`; jscpd offers no reordering signal because it
  can't see those files.
- If a duplication gate is ever wanted, it must run a tokenizer that doesn't drop
  large files — jscpd@4 as-is would false-green the god-files.

## Follow-up — how to actually inspect the god-files (the tools jscpd can't be)

Since jscpd is blind to the god-files, two file-size-agnostic instruments do the
real work. Both are now runnable:

### Instrument 1 — `scripts/profile-godfiles.mjs` (`pnpm run profile:godfiles`)

TS-compiler-API profiler: ranks top-level functions by LOC and by **emission
density** (`op:` Instr-literals per LOC), which classifies the bloat *shape* and
routes each hotspot to its correct lever. Also gates regressions
(`pnpm run check:godfiles` — fails on a new mega-function or >40-LOC growth of a
tracked one; baseline `scripts/godfile-profile-baseline.json`, 62 tracked fns).

**Bloat partition across the 5 god-files (64,261 LOC total):**

| Shape | LOC | Lever |
|---|---|---|
| hand-emitted-runtime (high op-density) | **32,272** | self-host **#3256 / #3257 / #3258** |
| dispatch-hairball (huge LOC, low density) | **17,813** | IR migration **#2855** / legacy-delete **#3090** |
| orchestration (~0 ops) | 12,661 | leave — not bloat |

Density cleanly separates the shapes: `ensureObjectRuntime` (7,355 LOC, d=0.39),
`ensureNativeStringHelpers` (4,844 LOC, d=0.46) → self-host; `compileCallExpression`
(13,202 LOC, d=0.10 — 69% of calls.ts in one function) → dispatch hairball;
`generateModule`/`registerWasiImports` (d≈0) → orchestration, leave alone.

### Instrument 2 — `audit-legacy-reachability.mjs --json`, filtered to god-files

The existing reachability audit sizes the **#3090 deletion prize inside** the
god-files — functions reachable *only* through the legacy dispatch pair, which die
when the IR supersedes their AST kind:

| File | total | legacy-only | shared (runtime) | dead |
|---|---|---|---|---|
| `expressions/calls.ts` | 19,250 | **17,604** | 0 | 0 |
| `array-methods.ts` | 10,153 | **8,954** | 0 | 0 |
| `native-strings.ts` | 7,457 | 1,203 | 5,988 | 0 |
| `index.ts` | 15,792 | 391 | 13,008 | 14 |
| `object-runtime.ts` | 11,609 | 147 | 10,543 | 0 |
| **totals** | 64,261 | **28,299** | 29,539 | **14** |

Reading: **28,299 LOC is legacy-only** (deletable once the IR owns those kinds —
#2855/#3090, gated), **29,539 is shared runtime** (not deletable by IR migration —
only compressible by self-hosting, #3256–#3258), and **only 14 LOC is truly dead**
(matches the knip finding — nothing free to sweep). The two classifiers agree:
`calls.ts` is legacy-only *and* a dispatch-hairball → #2855/#3090;
`object-runtime.ts`/`native-strings.ts` are shared *and* hand-emitted-runtime →
self-host. **The backlog (#3256–#3258 + #2855/#3090) already targets every
high-signal hotspot** the profilers surface — no orphan bloat.
