// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2527 / #2514 — canonical runtime-type rec-group identity primitive.
//
// Core-wasm module linking in a shared store (the CHOSEN approach for #2527)
// relies on WasmGC *engine canonicalization*: two separately-compiled modules
// that declare structurally-identical rec groups get the SAME runtime type, so
// GC objects (String / Vec / boxed) flow across an import/export boundary with
// zero copy. Phase 0 (issue #2527) proved this holds on V8 and wasmtime.
//
// For that to work in practice, EVERY js2wasm artifact (a future shared
// `runtime.wasm` AND every user module) must emit the *identical* canonical rec
// group — canonicalization matches whole groups, not individual types, and is
// sensitive to member set, member order, and structure (but NOT to type names
// or absolute type indices). The documented main risk (#2514 risk #2) is that
// `wasm-opt` merges/reorders/renames types, which would break canonical
// equality silently.
//
// This module provides the *identity primitive* that makes the ABI verifiable:
//
//   1. RUNTIME_RECGROUP_TYPE_NAMES — the closed, ordered set of GC type names
//      that form the shared runtime-type boundary group.
//   2. canonicalHashOfTypeGroup() — a deterministic, name-independent,
//      absolute-index-independent structural hash of an ordered run of type
//      defs. Two structurally-identical groups (modulo names/indices) hash
//      equal; any structural or ordering difference changes the hash. This
//      mirrors WasmGC isorecursive canonicalization semantics, so an equal hash
//      is a sound proxy for "the engine will canonicalize these to the same
//      runtime type".
//   3. extractRuntimeGroup() / fingerprintRuntimeGroup() — locate the runtime
//      types in a module's flat type table and produce a stable fingerprint
//      usable as a drift gate (CI / post-`wasm-opt` verification).
//
// This is pure analysis: it reads a module's type table and computes a hash. It
// emits nothing and changes no codegen, so wiring it (behind a verification
// gate) is behavior-neutral. The follow-on phases (emit the types as one frozen
// contiguous rec group; import the helpers from `runtime.wasm`) build on this
// primitive.

import type {
  ArrayTypeDef,
  FieldDef,
  FuncTypeDef,
  StructTypeDef,
  SubTypeDef,
  TypeDef,
  ValType,
  WasmModule,
} from "../ir/types.js";

/**
 * The closed, ordered set of runtime GC type names that form the shared
 * runtime-type boundary rec group (#2514). These are the WasmGC types whose
 * objects cross a core-wasm link boundary between a user module and the shared
 * runtime: the string family and the vec/array family.
 *
 * Order here is the *canonical* member order the ABI freezes; the emit phase
 * (follow-on) will lay these out contiguously in this order so every artifact
 * produces a byte-identical group. The hash below is order-sensitive, so this
 * list IS the versioned ABI contract for membership + order.
 *
 * NOTE: not every module declares every one of these (DCE prunes unused types),
 * so the verifier works on the *subset present*, preserving relative order.
 *
 * IMPORTANT — names are the *in-memory* TypeDef names (no `$` prefix). The `$`
 * appears only in WAT rendering, not in the IR `name` field, so the verifier
 * (which reads `mod.types[i].name`) matches the bare names below.
 *
 * Only types with a *name-stable* identity belong here. The externref vec/arr
 * variants are emitted with an index-suffixed name (`__arr_ref_6`,
 * `__vec_ref_6`, where `6` is the referenced type index) which is NOT stable
 * across modules — so they are intentionally excluded from the name-keyed ABI
 * boundary. Their structural identity is still verified transitively when a
 * group member refs them (as an external `x` token).
 */
export const RUNTIME_RECGROUP_TYPE_NAMES: readonly string[] = [
  // String family (i16-array native-string backend).
  "AnyString",
  "NativeString",
  "ConsString",
  "__str_data",
  // Vec / array family (name-stable members only).
  "__vec_base",
  "__vec_f64",
  "__arr_f64",
];

/** ABI version of the canonical runtime rec group. Bump on any membership,
 *  order, or structural change to a type in {@link RUNTIME_RECGROUP_TYPE_NAMES}. */
export const RUNTIME_RECGROUP_ABI_VERSION = 1;

const RUNTIME_NAME_SET = new Set(RUNTIME_RECGROUP_TYPE_NAMES);

/** A flat type table member (no nested `rec` wrappers). */
type FlatTypeDef = FuncTypeDef | StructTypeDef | ArrayTypeDef | SubTypeDef;

/** The name a TypeDef carries, if any (func types may be anonymous). */
function typeDefName(t: TypeDef): string | undefined {
  switch (t.kind) {
    case "func":
    case "struct":
    case "array":
      return t.name;
    case "sub":
      return t.name;
    case "rec":
      return undefined;
  }
}

/**
 * Canonicalize a ValType to a name-independent token. Ref types are encoded
 * relative to the group: a ref to a member of the group is `r<localIndex>`
 * (intra-group topology, position-relative — what canonicalization actually
 * compares), a ref outside the group is `x` (an opaque external marker — its
 * absolute index is not part of THIS group's canonical identity), and abstract
 * heap types pass through structurally.
 *
 * `localOf` maps an absolute type index to its 0-based position within the
 * group, or undefined if the index is not a group member.
 */
function valTypeToken(t: ValType, localOf: (absIdx: number) => number | undefined): string {
  switch (t.kind) {
    case "ref":
    case "ref_null": {
      const local = localOf(t.typeIdx);
      const nul = t.kind === "ref_null" ? "n" : "";
      if (local !== undefined) return `${nul}r${local}`;
      return `${nul}x`;
    }
    case "i32":
      return t.boolean ? "i32b" : "i32";
    case "i64":
      return t.bigint ? "i64big" : "i64";
    default:
      return t.kind;
  }
}

function fieldToken(f: FieldDef, localOf: (absIdx: number) => number | undefined): string {
  return `${f.mutable ? "m" : ""}${valTypeToken(f.type, localOf)}`;
}

/** Structural token for a single (already-unwrapped) type def, relative to the group. */
function structuralToken(t: FlatTypeDef, localOf: (absIdx: number) => number | undefined): string {
  switch (t.kind) {
    case "func": {
      const p = t.params.map((v) => valTypeToken(v, localOf)).join(",");
      const r = t.results.map((v) => valTypeToken(v, localOf)).join(",");
      return `func(${p})->(${r})`;
    }
    case "struct": {
      const sup =
        t.superTypeIdx !== undefined && t.superTypeIdx >= 0
          ? (() => {
              const local = localOf(t.superTypeIdx);
              return local !== undefined ? `sub r${local}${t.final ? "!" : ""} ` : `sub x${t.final ? "!" : ""} `;
            })()
          : "";
      const fields = t.fields.map((f) => fieldToken(f, localOf)).join(";");
      return `${sup}struct{${fields}}`;
    }
    case "array":
      return `array<${t.mutable ? "m" : ""}${valTypeToken(t.element, localOf)}>`;
    case "sub": {
      const sup =
        t.superType !== null
          ? (() => {
              const local = localOf(t.superType);
              return local !== undefined ? `sub r${local}${t.final ? "!" : ""} ` : `sub x${t.final ? "!" : ""} `;
            })()
          : t.final
            ? "final "
            : "";
      return `${sup}${structuralToken(t.type, localOf)}`;
    }
  }
}

/** FNV-1a 64-bit over a string; returns a 16-char lowercase hex digest. */
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * Compute a deterministic, name-independent, absolute-index-independent
 * structural canonical hash of an ordered group of type defs.
 *
 * `absIndices[i]` is the absolute type index of `group[i]` in the owning
 * module's type space (used to resolve intra-group refs to local positions).
 *
 * Two groups that are structurally identical modulo type names and absolute
 * placement produce the same hash; any change in member set, member order, or
 * the structure/intra-group topology of any member changes it. This is the
 * soundness proxy for "the engine canonicalizes these to the same runtime
 * type".
 */
export function canonicalHashOfTypeGroup(group: readonly FlatTypeDef[], absIndices: readonly number[]): string {
  const indexToLocal = new Map<number, number>();
  for (let i = 0; i < absIndices.length; i++) indexToLocal.set(absIndices[i]!, i);
  const localOf = (absIdx: number): number | undefined => indexToLocal.get(absIdx);

  const parts: string[] = [`v${RUNTIME_RECGROUP_ABI_VERSION}`, `n${group.length}`];
  for (let i = 0; i < group.length; i++) {
    parts.push(`${i}:${structuralToken(group[i]!, localOf)}`);
  }
  return fnv1a64(parts.join("|"));
}

/** A member of the extracted runtime group: its name + absolute index + def. */
export interface RuntimeGroupMember {
  /** Type name within the runtime rec-group. */
  name: string;
  /** Absolute type index of the member in the module's type table. */
  absIndex: number;
  /** Flattened structural definition of the member type. */
  def: FlatTypeDef;
}

/**
 * Locate the runtime-type members present in a module's flat type table, in
 * the module's emission order. Only types whose name is in
 * {@link RUNTIME_RECGROUP_TYPE_NAMES} are returned (a module that doesn't use
 * strings/vecs simply yields a subset, or none).
 *
 * Requires a *flat* type table (no nested `rec` wrappers), which is the shape
 * codegen produces today (`computeRecGroups` derives groups at emit time, the
 * `mod.types` array itself is flat).
 */
export function extractRuntimeGroup(mod: WasmModule): RuntimeGroupMember[] {
  const out: RuntimeGroupMember[] = [];
  const types = mod.types;
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    if (t.kind === "rec") continue; // not expected in the flat table; skip defensively
    const name = typeDefName(t);
    if (name !== undefined && RUNTIME_NAME_SET.has(name)) {
      out.push({ name, absIndex: i, def: t });
    }
  }
  return out;
}

/** Result of fingerprinting a module's runtime rec group. */
export interface RuntimeGroupFingerprint {
  /** ABI version this fingerprint was computed under. */
  abiVersion: number;
  /** Canonical structural hash (the identity proxy). */
  hash: string;
  /** Member names in emission order — the membership+order half of the ABI. */
  members: string[];
  /** Number of runtime types present. */
  count: number;
}

/**
 * Produce a stable fingerprint of a module's runtime rec group: the structural
 * canonical hash plus the ordered member list. Equal fingerprints across two
 * artifacts ⇒ their runtime GC types will canonicalize to the same runtime
 * type, so GC objects can cross a core-wasm link between them.
 *
 * This is the building block for a drift gate: capture the fingerprint of a
 * reference artifact (e.g. the future `runtime.wasm`) and assert every user
 * module reproduces it, including AFTER `wasm-opt` (the #2514 risk #2 check).
 */
export function fingerprintRuntimeGroup(mod: WasmModule): RuntimeGroupFingerprint {
  const members = extractRuntimeGroup(mod);
  return {
    abiVersion: RUNTIME_RECGROUP_ABI_VERSION,
    hash: canonicalHashOfTypeGroup(
      members.map((m) => m.def),
      members.map((m) => m.absIndex),
    ),
    members: members.map((m) => m.name),
    count: members.length,
  };
}
