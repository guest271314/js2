#!/usr/bin/env node
// Standalone unit tests for the CLA gate's pure logic (#1660).
// Dependency-free (node:test) so it runs anywhere without the project toolchain:
//   node --test .github/cla/cla-gate.test.mjs
//
// These tests cover the exemption + signature logic IN ISOLATION. They do NOT
// hit the GitHub API and do NOT fire the workflow against any live PR.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBot,
  commentMatchesPhrase,
  staticExemptReason,
  hasSigned,
  makeSignature,
  appendSignature,
  computeClaVersion,
  AGREEMENT_PHRASE,
} from "./cla-gate.mjs";

const allowlist = {
  exempt_logins: ["ttraenkler", "github-actions[bot]", "dependabot[bot]"],
  exempt_orgs: ["loopdive"],
};

test("isBot detects [bot] suffix", () => {
  assert.equal(isBot("github-actions[bot]"), true);
  assert.equal(isBot("dependabot[bot]"), true);
  assert.equal(isBot("renovate[bot]"), true);
  assert.equal(isBot("guest271314"), false);
  assert.equal(isBot("ttraenkler"), false);
  assert.equal(isBot(undefined), false);
});

test("commentMatchesPhrase is exact (trim + case-insensitive)", () => {
  assert.equal(commentMatchesPhrase(AGREEMENT_PHRASE), true);
  assert.equal(commentMatchesPhrase("  I have read and agree to the CLA  "), true);
  assert.equal(commentMatchesPhrase("i have read and agree to the cla"), true);
  assert.equal(commentMatchesPhrase("I agree to the CLA"), false);
  assert.equal(commentMatchesPhrase("I have read and agree to the CLA, thanks!"), false);
  assert.equal(commentMatchesPhrase("LGTM"), false);
  assert.equal(commentMatchesPhrase(undefined), false);
});

test("staticExemptReason: bots are exempt", () => {
  assert.equal(staticExemptReason("github-actions[bot]", allowlist), "bot");
  assert.equal(staticExemptReason("some-random[bot]", allowlist), "bot");
});

test("staticExemptReason: allowlisted maintainer exempt (case-insensitive)", () => {
  assert.equal(staticExemptReason("ttraenkler", allowlist), "allowlist");
  assert.equal(staticExemptReason("TTraenkler", allowlist), "allowlist");
});

test("staticExemptReason: external human NOT statically exempt", () => {
  // External humans are only exempt via live org membership, not statically.
  assert.equal(staticExemptReason("guest271314", allowlist), null);
});

test("hasSigned matches login + version", () => {
  const sigs = [{ login: "guest271314", cla_version: "sha256:aaaa" }];
  assert.equal(hasSigned(sigs, "guest271314", "sha256:aaaa"), true);
  assert.equal(hasSigned(sigs, "GUEST271314", "sha256:aaaa"), true); // case-insens
  assert.equal(hasSigned(sigs, "guest271314", "sha256:bbbb"), false); // version bump
  assert.equal(hasSigned(sigs, "other", "sha256:aaaa"), false);
  assert.equal(hasSigned([], "x", "v"), false);
});

test("appendSignature is idempotent per version", () => {
  const store = { signatures: [] };
  const sig = makeSignature({
    login: "guest271314",
    name: "Guest",
    pr: 589,
    commitSha: "deadbeef",
    claVersion: "sha256:aaaa",
    signedAt: "2026-05-24T00:00:00Z",
  });
  const r1 = appendSignature(store, sig);
  assert.equal(r1.added, true);
  assert.equal(r1.store.signatures.length, 1);

  const r2 = appendSignature(r1.store, sig);
  assert.equal(r2.added, false, "same login+version should not double-record");
  assert.equal(r2.store.signatures.length, 1);

  // A version bump (CLA changed) requires a fresh signature.
  const sig2 = makeSignature({
    login: "guest271314",
    name: "Guest",
    pr: 700,
    commitSha: "cafe",
    claVersion: "sha256:bbbb",
  });
  const r3 = appendSignature(r2.store, sig2);
  assert.equal(r3.added, true);
  assert.equal(r3.store.signatures.length, 2);
});

test("makeSignature shape", () => {
  const sig = makeSignature({
    login: "x",
    pr: 1,
    commitSha: "abc",
    claVersion: "v",
  });
  assert.deepEqual(Object.keys(sig).sort(), ["cla_version", "commit_sha", "login", "name", "pr", "signed_at"]);
  assert.equal(sig.name, "x"); // defaults to login
  assert.match(sig.signed_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("computeClaVersion is deterministic + sensitive to content", () => {
  const a = computeClaVersion("hello");
  const b = computeClaVersion("hello");
  const c = computeClaVersion("hello!");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^sha256:[0-9a-f]{12}$/);
});
