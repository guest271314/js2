# Compiler code review — 2026-06-04

Scope: full read-only review of the compiler (`src/`, ~180k LOC) for **correctness
bugs**, **redundancies/dead code**, and **conformance against the ECMAScript and
WebAssembly specs**. Conducted via 11 parallel review passes (7 module-focused +
4 spec-conformance) on `main` @ `f692249d`; the highest-impact findings were
re-verified by hand against the cited source.

Findings are grouped by **reachability**, because the codebase has a common
JS-host path plus several latent paths (standalone/WASI, the `.o` linker, and
some dead modules). Each finding lists the tracking issue filed on 2026-06-04.

Several findings are **residuals of issues already marked `done`** (#1361 sort,
#1334 defineProperty, #1335 number-format, #1798 IR return-type) — the original
fix was incomplete or has regressed; the new issue cites the original.

---

## Summary

| # | Issue | Sev | Area | Path |
|---|-------|-----|------|------|
| 1 | #1815 | high | `splice` drops inserted items | JS-host |
| 2 | #1816 | high | `sort` ignores comparator; default not lexicographic (residual #1361) | JS-host |
| 3 | #1817 | high | `>>>` i32 fast-path produces signed result | JS-host |
| 4 | #1818 | high | i32/boolean default param fires on `0`/`false` | JS-host |
| 5 | #1819 | high | logical-assignment reads globals at wrong index | JS-host |
| 6 | #1820 | high | IR `&&`/`||`/ternary evaluate both operands | JS-host (IR) |
| 7 | #1821 | med | `delete obj.prop` always returns `true`; `delete obj["k"]` skips sidecar | JS-host |
| 8 | #1822 | med | `String#replace`/`replaceAll` ignore `$` substitution patterns | JS-host |
| 9 | #1823 | med | `String#normalize(form)` evaluates arg before receiver | JS-host |
| 10 | #1824 | med | `super` as a value returns wrong static type | JS-host |
| 11 | #1825 | med | i32 fast-mode `%` emits trapping `i32.rem_s` | JS-host (fast) |
| 12 | #1826 | med | `OrdinaryToPrimitive`: `valueOf` returning `undefined` treated as absent | JS-host |
| 13 | #1827 | med | BigInt loose-equality loses precision / wrong semantics | JS-host |
| 14 | #1828 | med | array-like `find`/`findIndex` skip holes; `map` compacts holes | JS-host |
| 15 | #1829 | high | `marshalTypedArrayArgs` byte-masks non-`Uint8Array` typed arrays | JS-host |
| 16 | #1830 | med | well-known-symbol range off-by-one excludes `Symbol.matchAll` | JS-host |
| 17 | #1831 | med | `_validatePropertyDescriptor` resets omitted attrs on redefine (residual #1334) | JS-host |
| 18 | #1832 | med | `compileNewFunctionExpression` captures outer var shadowed by destructured param | JS-host |
| 19 | #1833 | med | implicit subclass forwarder truncates multi-arg `super(...)` | JS-host |
| 20 | #1834 | med | vec element-write index uses trapping `i32.trunc_f64_s` | JS-host |
| 21 | #1835 | high | C-ABI string/array marshaling reads wrong header offsets | WASI/standalone |
| 22 | #1836 | high | standalone Number↔String conformance gaps (residual #1335) | standalone |
| 23 | #1837 | med | standalone enumeration order is hash-bucket order | standalone |
| 24 | #1838 | med | linear backend silently miscompiles `try/catch` | standalone |
| 25 | #1839 | med | late string-import index shift omits init body / helpers / start func | JS-host (nativeStrings) |
| 26 | #1840 | low | linker `writeLEB128` truncates growing indices; rewrite gaps | latent (linker) |
| 27 | #1841 | low | element-section flag bitfield only handles active flag-0 | latent (linker) |
| 28 | #1842 | low | `none` heap-type constant collides with `any` | latent (emit) |
| 29 | #1843 | low | `R_WASM_TAG_INDEX_LEB` emitter/reader mismatch (11 vs 10) | latent (linker) |
| 30 | #1844 | low | IR `verify` doesn't recurse nested if/try/loop buffers (residual #1798) | defense-in-depth |
| 31 | #1845 | low | IR propagate: `&&`/`||` over-claim `BOOL`; `seedConcrete` omits i32/u32 | latent (IR) |
| 32 | #1846 | low | minor `typeof` notes (i64→"number" in `with`; externref→null) | minor |
| 33 | #1847 | low | for-of tentative rollback doesn't restore `fctx.localMap` | robustness |
| 34 | #1848 | — | dead-code sweep (identical branches, unused locals/params) | redundancy |
| 35 | #1849 | — | duplicate-logic refactor (diverged copy-paste) | redundancy |

---

## 1. Reachable correctness bugs (common JS-host path)

### #1815 — `Array.prototype.splice` drops inserted items (high)
`src/codegen/array-methods.ts:4421` (`compileArraySplice`), dispatch `:2574`.
Reads only `start`/`deleteCount`; never reads `arguments[2..]`. `[1,2,3].splice(1,1,'a','b')`
→ `[1,3]` instead of `[1,'a','b',3]`. ECMAScript §23.1.3.30. `toSpliced` already
implements item insertion correctly (`:2899`) — reuse that shape.

### #1816 — `Array.prototype.sort` ignores a user comparator; default sort is numeric, not lexicographic (high) — residual of #1361 (done, s51)
`src/codegen/array-methods.ts:5781-5816` + `src/codegen/timsort.ts`.
A callable `(a,b)=>b-a` passes the non-callable guard then is discarded →
`[3,1,2].sort((a,b)=>b-a)` yields `[1,2,3]`. No-arg `[10,9,1].sort()` must compare
by ToString per §23.1.3.30 (`"1","10","9"`) but sorts numerically. The only test
asserts "doesn't throw," which masked the regression. `ensureTimsortHelper` takes
no comparator and hard-codes `i32.lt_s`/`f64.lt`. Fix: thread the comparator
funcref through `call_ref`, and ToString-compare in the no-arg case.

### #1817 — `>>>` i32 fast path produces a signed result (high)
`src/codegen/binary-ops.ts:1334`/`:1318`. `isI32PureExpr` admits `>>>`; the i32
result is later widened with `f64.convert_i32_s`, so `(x >>> 0)` with the high bit
set yields a *negative* float. The slow path correctly uses `f64.convert_i32_u`.
§6.1.6.1 / ToUint32. Fix: exclude `>>>` from the i32-pure fast path (or convert via
`_u` when the consumer wants f64).

### #1818 — i32/boolean parameter default fires on a legitimate `0`/`false` (high)
`src/codegen/closures.ts:767`, `src/codegen/class-bodies.ts:1076`. Uses `i32.eqz`
as the "argument missing" sentinel. `function f(b=true){}; f(false)` → `b===true`;
`function f(n:number=5){}; f(0)` → `5`. The f64 path correctly uses a NaN self-test;
the array/object-pattern paths already *skip* the check for i32 (closures.ts:714).
Fix: don't emit a default check for plain i32/boolean params (thread an explicit
arg-present flag instead of reusing `0`).

### #1819 — logical-assignment (`??=`/`||=`/`&&=`) reads globals at the wrong index (high)
`src/codegen/expressions/assignment.ts:3159` & `:3170`. Uses raw absolute index
`ctx.mod.globals[capturedIdx]` while every other access in the file wraps with
`localGlobalIdx(ctx, …)` (verified: lines 260/276/590/2198/2236/2594/4536/4568).
When import globals exist, `varType` falls back to f64, so a ref-typed global skips
the null/undefined branch and mis-evaluates. **Verified by hand.**

### #1820 — IR short-circuit operators evaluate both sides (high)
`src/ir/from-ast.ts:3464` (ternary → `select`) and `:3676` (`&&`/`||` →
`i32.and`/`i32.or`). The selector admits `CallExpression` arms, so `cond ? f() : g()`
calls **both**, and `n<=1 ? 1 : n*fact(n-1)` recurses at the base case
(non-termination). `p!==null && p.use()` loses its guard. Related Wasm-validity facet:
a ref-typed ternary would emit untyped `select` (0x1B), invalid for reference operands
(needs typed `0x1C`) — `src/emit/binary.ts:704`. Fix: only `select` when both arms are
provably side-effect-free **and** numeric; otherwise lower to the short-circuiting
`IrInstrIf` (already exists) or fall back to legacy.

### #1821 — `delete obj.prop` always returns `true`; `delete obj["k"]` skips sidecar cleanup (med)
`src/codegen/typeof-delete.ts:127` (struct fast path drops `__delete_property`'s
result, pushes `i32.const 1` → reports success on non-configurable props; spec
`false`/strict throw) and `:192` (`delete obj["literal"]` omits the `__delete_property`
sidecar that `delete obj.prop` performs, so `hasOwnProperty` diverges between the two
syntaxes). §13.5.1. Fix: return the helper result for struct fields; mirror the sidecar
in the element-access arm.

### #1822 — `String#replace`/`replaceAll` ignore `$` substitution patterns (med)
`src/codegen/native-strings.ts:3217`/`:3294`. Replacement concatenated verbatim;
ignores `$$`/`$&`/`` $` ``/`$'` (§22.1.3.19 GetSubstitution). `"abc".replace("b","$&$&")`
→ `"a$&$&c"` instead of `"abbc"`. `replaceAll("","-")` also returns the input unchanged
instead of interleaving. Fix: expand `$` patterns against the match before concat.

### #1823 — `String#normalize(form)` evaluates the argument before the receiver (med)
`src/codegen/string-ops.ts:2110`. For a non-literal form, compiles+drops the arg then
compiles the receiver — reversing spec left-to-right order (§13.3.6 / §22.1.3.13).
Fix: compile the receiver first (into a temp), then the arg.

### #1824 — `super` used as a value returns the wrong static type (med)
`src/codegen/expressions.ts:1249`. Uses `fctx.locals[selfIdx]` where the convention
(used by the `this` branch at `:861`) is `fctx.params[selfIdx]` for param indices. The
emitted `local.get` is correct; the returned ValType is an unrelated local's, which can
mis-drive coercion of a bare `super` value. Fix: mirror the ThisKeyword indexing.

### #1825 — i32 fast-mode `%` emits trapping `i32.rem_s` (med)
`src/codegen/binary-ops.ts:2337`, reachable via the i32 fast path (`%` is not excluded
the way `/`/`**` are). `x % 0` traps instead of `NaN`; `INT_MIN % -1` traps. §6.1.6.1.6
Number::remainder. Fix: route `%` through `emitModulo`, or guard with `b==0`/`INT_MIN/-1`.

### #1826 — `OrdinaryToPrimitive`: `valueOf` returning `undefined` treated as "absent" (med)
`src/runtime.ts:1943`. `tryMethod` returns JS `undefined` both for "absent/returned object"
and a real `undefined` primitive; the caller then tries `toString`. §7.1.1.1 steps 5-6.
`{valueOf(){return undefined}, toString(){return "x"}} + ""` → `"x"` instead of `"undefined"`.
Fix: use a distinct sentinel for absent.

### #1827 — BigInt loose-equality loses precision / wrong semantics (med)
`src/codegen/binary-ops.ts:976`. `BigInt == String` uses `parseFloat` instead of
StringToBigInt (`12n == "12px"` → `true`; spec `false`). `BigInt == Number` collapses
both to f64 (`9007199254740993n == 9007199254740992` → `true`; spec `false`). §7.2.13.
Fix: route BigInt×String through a StringToBigInt helper; compare BigInt×Number by exact
mathematical value (i64.eq when integral & in range).

### #1828 — array-like `find`/`findIndex` skip holes; `map` compacts holes (med)
`src/codegen/array-methods.ts:824` (find/findIndex wrap body in `gatedBody`, skipping
holes — spec visits them as `undefined`, §23.1.3.9/.10) and `:937` (map appends via
`__js_array_push`, compacting holes and shifting indices — spec preserves length,
§23.1.3.20). Only affects sparse array-like `.call` receivers; dense arrays are fine.

### #1829 — `marshalTypedArrayArgs` byte-masks non-`Uint8Array` typed arrays (high)
`src/runtime.ts:9855-9876`. Accepts both `"uint8array"` and `"typed-array"`, then writes
each element with `& 0xff` (line 9874). For `Int16Array`/`Int32Array`/`Float32Array`/
`Float64Array` (classified `"typed-array"`) this truncates every value to its low byte,
silently corrupting args. The vec store is f64, so full precision would round-trip. Fix:
apply `& 0xff` only for `"uint8array"`; write `src[j]` unmasked otherwise.

### #1830 — well-known-symbol range off-by-one excludes `Symbol.matchAll` (med)
`src/runtime.ts:3102`/`:3188`/`:5222`. `_symbolIdToKeys` maps IDs 1-15 (15 = `@@matchAll`),
but `_safeGet`/`_safeSet`/`__extern_has` gate on `<= 14`. `struct[Symbol.matchAll]`
get/set/`in` falls through to numeric access and misses the symbol-keyed property. The
comment still says "1-12". Fix: bound on `<= 15` (or derive from `_symbolIdToKeys.size`).

### #1831 — `_validatePropertyDescriptor` resets omitted attributes on redefine (med) — residual of #1334 (done, s50)
`src/runtime.ts:1262-1272`. `newFlags` is built from truthiness of each attribute, so an
omitted attribute contributes `0`; when `existing` is configurable it returns `newFlags`
directly, clearing previously-set `writable`/`enumerable`/`configurable`. §10.1.6.3 keeps
absent fields. `Object.defineProperty(o,"k",{value:5})` after `o.k` was enumerable/writable
clears those flags. Fix: start from `existing` and only overwrite explicitly-present fields.

### #1832 — `compileNewFunctionExpression` captures outer var shadowed by a destructured param (med)
`src/codegen/expressions/new-super.ts:1084`. `isOwnParam` only matches identifier params,
so `function({a}){…a…}` doesn't recognize `a` as own; an outer `a` is captured and shadows
the param. Fix: use `collectBindingPatternNames`/`isOwnParamName` (already exported).

### #1833 — implicit subclass forwarder truncates multi-arg `super(...)` (med)
`src/codegen/class-bodies.ts:1103-1131`. For `class Sub extends DataView {}` the synthetic
forwarder declares one externref `__arg0` and forwards only the first arg, so
`new Sub(buf,0,16)` drops `0` and `16`. Implicit derived constructors must forward all
args. (Noted as deferred #1366c, which has no file.) Fix: forward the full arg list.

### #1834 — vec element-write index uses trapping `i32.trunc_f64_s` (med)
`src/codegen/expressions/assignment.ts:1805` (and `:2305` for `arr.length = N`). Converts
the destructuring element-access index with the trapping op; every other index/length
conversion uses `i32.trunc_sat_f64_s` (`:3012,:3685,:4170,:5538`). A NaN/non-integer index
traps the module. Fix: use the saturating op.

---

## 2. Standalone / WASI bugs (supported targets)

### #1835 — C-ABI string/array marshaling reads the wrong header offsets (high)
`src/codegen-linear/c-abi.ts:269-273` computes return data ptr = `ptr+4` and length at
`offset 0`, but the verified linear layout is `[header 8B][len:u32 @ +8][bytes @ +12]`
(`src/codegen-linear/runtime.ts:505`) → should be `offset 8` and `ptr+12`. Param marshaling
(`:231`) has the mirror problem (forwards a raw `(ptr,len)` where the callee expects a
header object). The C ABI is effectively non-functional for string/array I/O. **Verified.**

### #1836 — standalone Number↔String conformance gaps (high) — residual of #1335 (done, s58)
All in the no-JS-host (standalone/WASI) path; JS-host is correct.
- `Number("0o17")`/`Number("0b101")` → `NaN` — only the hex prefix is handled
  (`src/codegen/parse-number-native.ts:949`). §7.1.4.1.
- `(1e21).toFixed(2)` emits a bogus 22-digit integer — no `≥1e21 → ToString` branch
  (`src/codegen/number-format-native.ts:894`). §21.1.3.3.
- `(1e-7).toString()`→`"0"`, `(1e21).toString()` lacks `e` — no exponential path
  (`number-format-native.ts:470`). §6.1.6.1.20.
- `(3.5).toString(2)` **traps** (`unreachable`) — fractional radix unimplemented (`:713`).
- `parseInt`/`parseFloat`/`Number` whitespace set misses BOM, U+2028/2029, most Zs
  (`parse-number-native.ts:61`).
- `+"12abc"` → `12` instead of `NaN` — ToNumber(String) falls back to `parseFloat`
  (`src/codegen/type-coercion.ts:1748`).

### #1837 — standalone enumeration order is hash-bucket order (med)
`src/codegen/object-runtime.ts:1097`. `Object.keys`/`values`/`entries`/for-in/spread/
`JSON.stringify` in standalone violate §10.1.11 (integer keys ascending, then insertion).
JS-host mode delegates to native and is correct. Fix: emit integer keys sorted ascending,
then string keys in insertion order (needs an insertion-sequence field).

### #1838 — linear backend silently miscompiles `try/catch` (med)
`src/codegen-linear/index.ts:669`. The catch clause is discarded and `throw` →
`unreachable`, so `try{throw}catch{}` traps instead of recovering, with no diagnostic.
Fix: emit EH `try`/`catch`, or raise a compile error in standalone mode.

### #1839 — late string-import index shift omits init body / helpers / start func (med)
`src/codegen/index.ts:6138`. `addStringImports` hand-rolls the func-index shift and misses
`pendingInitBody`, `nativeStrHelpers`, and `startFuncIdx` that the canonical
`shiftLateImportIndices` covers. If the first string use is inside a function body (not
module-init), `__module_init` can call the wrong funcs; also bites plain `--nativeStrings`
in host mode. Fix: call `shiftLateImportIndices` (single source of truth).

---

## 3. Latent bugs (paths not currently wired) — backlog

### #1840 — linker `writeLEB128` truncates growing indices; `call_indirect`/`memory` rewrite gaps (low)
`src/link/linker.ts:514/533/552`. Relocations rewritten into the original byte width; a
1-byte index resolving to ≥128 loses its high bits. Also `call_indirect` table index isn't
symbol-resolved, and `memory.size/grow` immediate is overwritten as a single raw byte.
Real linkers pad reloc immediates to 5 bytes. Latent: the `.o` linker isn't in the
production compile path.

### #1841 — element-section flag bitfield only handles active flag-0 (low)
`src/link/reader.ts:471` mis-parses passive(1)/declarative(3) segments (consumes a bogus
tableidx, always scans for an offset-expr); `src/link/linker.ts:401` re-emits everything as
active flag 0x00. WebAssembly binary §element. Latent (only active flag-0 is fed today).

### #1842 — `none` heap-type constant collides with `any` (low)
`src/emit/opcodes.ts:444` `none: 0x6e` equals `:439` `any: 0x6e` (spec `none=0x71`).
`noextern`/`nofunc` are also missing. `TYPE.none` isn't emitted today, so latent — but a
landmine. **Verified.**

### #1843 — `R_WASM_TAG_INDEX_LEB` emitter/reader mismatch (low)
`src/emit/opcodes.ts:480` = `11` vs `src/link/reader.ts:136` = `10` (LLVM canonical `10`).
Tag-index relocations can't round-trip. **Verified.** Fix: align both on `10`.

### #1844 — IR `verify` doesn't recurse into nested if/try/loop buffers (low) — residual of #1798 (done, s58)
`src/ir/verify.ts:393` (`operandIrType`) and `:141` (`verifyBlock`/`collectUses`) only scan
top-level block instrs, not nested `then`/`else`/`try`/`forof`/loop body buffers — while
`registerInstrDefs` in lower.ts does. So the #1798 return-type gate and SSA checks have a
hole exactly where control flow nests; a mismatch inside an `if` arm slips past the verifier
to instantiate-time (or a hard lower throw instead of a clean legacy fallback). Defense-in-depth.

### #1845 — IR propagate minor: `&&`/`||` over-claim `BOOL`; `seedConcrete` omits i32/u32 (low)
`src/ir/propagate.ts:615` infers `BOOL` for `a && b`/`a || b` when operands are
`boolCompatible` incl. optimistic `unknown`, but the result is the operand value, not a
boolean — can seed a non-boolean as `bool`. `:315` `seedConcrete` omits i32/u32 (currently
inert, latent once integer seeding is added).

### #1846 — minor `typeof` notes (low)
`staticTypeofForWasmType` maps i64→"number" (`src/codegen/typeof-delete.ts:831`), reachable
only via `with`-bindings (near-nil impact); the externref branch can return `null` for some
non-undefined object operands (`:684`, low confidence). §13.5.3.

### #1847 — for-of tentative rollback doesn't restore `fctx.localMap` (low)
`src/codegen/statements/loops.ts:2590` (and siblings). Rollbacks truncate `fctx.locals`/
`fctx.body` but not `fctx.localMap` (which `allocLocal` mutates), leaving stale entries
pointing past the truncated vector. Practical risk is low (temp names are keyed off
`locals.length`), but it's unbalanced state. Fix: snapshot/restore `localMap` + `tempFreeList`.

---

## 4. Redundancies / dead code — backlog

### #1848 — dead-code sweep
Verified one-liners and dead scaffolding:
- `src/codegen/type-coercion.ts:1065` — `from.kind==="ref_null" ? {anyref} : {anyref}`, both arms identical. **Verified.**
- `src/emit/binary.ts:440-444` — `if (...) {...} else {...}` both call the same `encodeTypeDef`. **Verified.**
- `src/codegen/stack-balance.ts:687` — `const fixups = 0` never reassigned; final `return fixups` always 0.
- `src/ir/from-ast.ts:793` — `const writes = new Set()` created then discarded.
- `src/codegen-linear/c-abi.ts:262-263` — `body.splice(body.length,0)` no-op + unused `callIdx`; plus dead `exportReplacements`/`mangleCabiName` (`:177`), and the `externalImports` placeholder in `linker.ts:225`.
- `src/codegen/expressions/unary-updates.ts:718` — `const isIncrement = false` constant-folds dead ternary arms in the `--` path.
- `src/compiler/validation.ts:448` — `const opStart` assigned, never read.
- `src/codegen/binary-ops.ts:2552` — `compileModulo` ignores both params.
- `src/codegen/type-coercion.ts:73,988` — deprecated `CompileStringLiteralFn` param of `coerceType` is unused.
- `src/codegen/statements/loops.ts:2398` — obsolete `__str_charAt` name-rescan (the comment's premise is no longer true since #1677); plus dead default-separator `else` in native `split` (`src/codegen/string-ops.ts:1994`).
- `src/emit/binary.ts` `encodeTypeDef` sub-branch dup; `src/link/linker.ts:417` unused `funcCounter`.

### #1849 — duplicate-logic refactor (diverged copy-paste — bug-magnets)
- `compileSuperElementMethodCall` ≈ `compileSuperMethodCall` (`new-super.ts:322` vs `:202`); fallbacks already differ.
- Two closure-iterable drainers with different loop caps/field resolution (`runtime.ts:1626` vs `:1720`).
- `resolveVec` duplicated verbatim (`ir/integration.ts:864` & `:985`).
- `__extern_has` `in`-operator block emitted twice (`binary-ops.ts:648` & `:730`).
- ~7× copy-pasted "emit typed default value" block in the super-access helpers (`new-super.ts`); `defaultValueInstrs`/`pushDefaultValue` already exist.
- `operandValType`/`operandIrType` carry an unused `localDefs` param (`ir/verify.ts:393`).

---

## What was checked and is correct

Recorded so these aren't re-litigated: ToInt32/ToUint32 modulo-2³² + sign; shift-count
masking; `Number::remainder` edge cases (`-0`, `x%Infinity`); `**` special cases; `+`
ToPrimitive "default" hint; SameValue/SameValueZero `-0`/NaN; strict-eq via `f64.eq`;
`includes` SameValueZero vs `indexOf` strict-eq; `reduce` empty-no-init TypeError;
LEB128 minimal encoding, memarg log2 alignment, section ordering, struct/array/rec/sub
GC encodings; `__malloc` alignment; `fromCharCode` ToUint16; call-site RangeError
validation for `toFixed`/`toExponential`/`toPrecision`/`toString` radix; native parseInt
0x-prefix/radix-clamp; `__str_to_number` full-match requirement.
