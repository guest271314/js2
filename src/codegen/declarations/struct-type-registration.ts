// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Interface- and object-type -> WasmGC struct registration. Maps TS members to
 * FieldDef[] and pushes a struct type. Extracted verbatim from
 * codegen/declarations.ts (#3268).
 */
import { mapTsTypeToWasm } from "../../checker/type-mapper.js";
import { ts } from "../../ts-api.js";
import { resolveWasmType } from "../index.js";
import type { FieldDef, StructTypeDef } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

export function collectInterface(ctx: CodegenContext, decl: ts.InterfaceDeclaration): void {
  const name = decl.name.text;
  const fields: FieldDef[] = [];

  for (const member of decl.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const memberName = (member.name as ts.Identifier).text;
      const memberType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(memberType, ctx.checker);
      fields.push({
        name: memberName,
        type: wasmType,
        mutable: true,
      });
    }
  }

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name,
    fields,
  } as StructTypeDef);
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(name, fields);
}

/**
 * After all interfaces and type aliases are collected, re-resolve field types
 * that were initially mapped to externref but should be ref $struct.
 * This handles cross-references between interfaces regardless of declaration order.
 */
export function resolveStructFieldTypes(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  for (const stmt of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(stmt) && !ts.isTypeAliasDeclaration(stmt)) continue;

    const name = ts.isInterfaceDeclaration(stmt) ? stmt.name.text : stmt.name.text;
    const fields = ctx.structFields.get(name);
    const structTypeIdx = ctx.structMap.get(name);
    if (!fields || structTypeIdx === undefined) continue;

    let changed = false;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      if (field.type.kind !== "externref") continue;

      // Try to re-resolve using resolveWasmType which knows about structs
      let memberTsType: ts.Type | undefined;
      if (ts.isInterfaceDeclaration(stmt)) {
        for (const member of stmt.members) {
          if (ts.isPropertySignature(member) && member.name) {
            const memberName = (member.name as ts.Identifier).text;
            if (memberName === field.name) {
              memberTsType = ctx.checker.getTypeAtLocation(member);
              break;
            }
          }
        }
      } else {
        const aliasType = ctx.checker.getTypeAtLocation(stmt);
        const props = aliasType.getProperties();
        for (const prop of props) {
          if (prop.name === field.name) {
            memberTsType = ctx.checker.getTypeOfSymbol(prop);
            break;
          }
        }
      }

      if (!memberTsType) continue;
      const resolved = resolveWasmType(ctx, memberTsType);
      if (resolved.kind === "ref" || resolved.kind === "ref_null") {
        field.type = resolved;
        changed = true;
      }
    }

    // If any fields changed, update the type definition in mod.types too
    if (changed) {
      const typeDef = ctx.mod.types[structTypeIdx];
      if (typeDef && typeDef.kind === "struct") {
        (typeDef as any).fields = fields;
      }
    }
  }
}

export function collectObjectType(ctx: CodegenContext, name: string, type: ts.Type): void {
  const fields: FieldDef[] = [];
  for (const prop of type.getProperties()) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const wasmType = mapTsTypeToWasm(propType, ctx.checker);
    fields.push({
      name: prop.name,
      type: wasmType,
      mutable: true,
    });
  }

  if (fields.length > 0) {
    const typeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name,
      fields,
    } as StructTypeDef);
    ctx.structMap.set(name, typeIdx);
    ctx.typeIdxToStructName.set(typeIdx, name);
    ctx.structFields.set(name, fields);
  }
}
