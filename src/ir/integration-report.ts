// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "./identity.js";
import {
  classifyIrFailure,
  type IrInvariantCode,
  type IrPreparationFailure,
  type IrPreparationStage,
} from "./outcomes.js";
import type { IrLegacyUnitProjection } from "./planning-identity.js";

export interface IrIntegrationReport {
  readonly compiled: readonly string[];
  readonly errors: readonly IrIntegrationError[];
  /** Exact terminal-owner evidence retained beside the public name lists. */
  readonly terminalEvidence?: readonly IrIntegrationTerminalEvidence[];
  /** Public compiled entries that are exact terminal owners. */
  readonly terminalCompiledOwners?: readonly string[];
  /** Public compiled entries that are synthetic artifacts, not terminal rows. */
  readonly syntheticCompiledArtifacts?: readonly string[];
}

export type IrIntegrationTerminalEvidence =
  | { readonly kind: "patched"; readonly unitId: IrUnitId; readonly legacyName: string }
  | {
      readonly kind: "failed";
      readonly unitId: IrUnitId;
      readonly legacyName: string;
      /** Representative failure retained for compatibility and outcome choice. */
      readonly error: IrIntegrationError;
      /** Every public diagnostic object covered by this one logical event. */
      readonly errors?: readonly IrIntegrationError[];
    };

export interface IrIntegrationTerminalFailureEvent {
  readonly error: IrIntegrationError;
  readonly errors: readonly IrIntegrationError[];
}

export interface IrIntegrationError {
  readonly func: string;
  readonly message: string;
  readonly kind: "verify" | "build" | "lower" | "backend-legality";
  readonly outcome: IrPreparationFailure;
}

function legacyIntegrationKind(stage: IrPreparationStage): IrIntegrationError["kind"] {
  if (stage === "verify") return "verify";
  if (stage === "backend-legality") return "backend-legality";
  if (stage === "lower" || stage === "patch") return "lower";
  return "build";
}

export function integrationFailure(func: string, outcome: IrPreparationFailure): IrIntegrationError {
  return {
    func,
    message: outcome.detail,
    kind: legacyIntegrationKind(outcome.stage),
    outcome,
  };
}

export function invariantIntegrationFailure(
  func: string,
  code: IrInvariantCode,
  stage: Exclude<IrPreparationStage, "select">,
  detail: string,
): IrIntegrationError {
  return integrationFailure(func, { kind: "invariant", code, stage, detail });
}

export function caughtIntegrationFailure(
  func: string,
  error: unknown,
  stage: Exclude<IrPreparationStage, "select">,
): IrIntegrationError {
  return integrationFailure(func, classifyIrFailure(error, stage));
}

/** Public diagnostics plus the logical failures they describe. */
export class IrIntegrationFailureLog {
  readonly errors: IrIntegrationError[] = [];
  readonly terminalFailureEvents: IrIntegrationTerminalFailureEvent[] = [];

  record(error: IrIntegrationError): void {
    this.errors.push(error);
    this.terminalFailureEvents.push({ error, errors: [error] });
  }

  /** Preserve every verifier detail while emitting one logical failure event. */
  recordVerifierDetails(func: string, details: readonly { readonly message: string }[], detailPrefix = ""): void {
    this.recordVerifierGroups(func, [{ details, detailPrefix }]);
  }

  /** Aggregate verifier details from every artifact in one owner build. */
  recordVerifierGroups(
    func: string,
    groups: Iterable<{
      readonly details: readonly { readonly message: string }[];
      readonly detailPrefix: string;
    }>,
  ): boolean {
    const eventErrors: IrIntegrationError[] = [];
    for (const group of groups) {
      for (const detail of group.details) {
        const error = invariantIntegrationFailure(
          func,
          "verifier-failure",
          "verify",
          `${group.detailPrefix}${detail.message}`,
        );
        this.errors.push(error);
        eventErrors.push(error);
      }
    }
    const error = eventErrors[0];
    if (error) this.terminalFailureEvents.push({ error, errors: eventErrors });
    return error !== undefined;
  }
}

function syntheticCompiledArtifacts(compiled: readonly string[], terminalOwners: readonly string[]): string[] {
  const remainingOwners = new Map<string, number>();
  for (const name of terminalOwners) remainingOwners.set(name, (remainingOwners.get(name) ?? 0) + 1);
  return compiled.filter((name) => {
    const remaining = remainingOwners.get(name) ?? 0;
    if (remaining === 0) return true;
    remainingOwners.set(name, remaining - 1);
    return false;
  });
}

/**
 * Attach exact terminal evidence without changing the legacy public telemetry.
 *
 * `terminalFailureEvents` carries the producer's logical event boundaries.
 * When it is omitted, each public error is conservatively one event; this pure
 * constructor never guesses that same-owner errors are duplicate details.
 * Patched and failed evidence use independent passes deliberately, so
 * observing both remains two events for the terminal-evidence audit.
 */
export function buildIrIntegrationReport(
  compiled: readonly string[],
  errors: readonly IrIntegrationError[],
  ownerProjection?: IrLegacyUnitProjection,
  compiledOwners: readonly string[] = compiled,
  terminalFailureEvents: readonly (IrIntegrationTerminalFailureEvent | IrIntegrationError)[] = errors,
): IrIntegrationReport {
  if (!ownerProjection) return { compiled, errors };

  const terminalEvidence: IrIntegrationTerminalEvidence[] = [];
  for (const legacyName of compiledOwners) {
    const owner = ownerProjection.requireLegacyName(legacyName);
    terminalEvidence.push({ kind: "patched", unitId: owner.unitId, legacyName: owner.legacyName });
  }

  for (const failureEvent of terminalFailureEvents) {
    const event = "errors" in failureEvent ? failureEvent : { error: failureEvent, errors: [failureEvent] };
    const owner = ownerProjection.requireLegacyName(event.error.func);
    terminalEvidence.push({
      kind: "failed",
      unitId: owner.unitId,
      legacyName: owner.legacyName,
      error: event.error,
      errors: event.errors,
    });
  }
  return {
    compiled,
    errors,
    terminalEvidence,
    terminalCompiledOwners: compiledOwners,
    syntheticCompiledArtifacts: syntheticCompiledArtifacts(compiled, compiledOwners),
  };
}
