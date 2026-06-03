---
name: project_open_foundation_not_product
description: "js2wasm is framed publicly as a fully-open technical foundation, NOT a commercial product; CLA keeps relicensing optionality privately"
metadata:
  node_type: memory
  type: project
  originSessionId: 860a3c3b-e1bd-43b0-908e-f386476cd216
---

js2wasm's public identity (per the user, 2026-05-31): a **fully-open-source
technical foundation for the next-generation internet, deliberately not run as a
commercial product**. Loopdive GmbH is the steward, not "a compiler company,"
and js2wasm is explicitly *not* "the core compiler product of Loopdive GmbH"
(that pre-existing wording was disowned and removed from README + CONTRIBUTING).

**Why:** the project must be fully open to serve as shared internet
infrastructure; that openness is the point, so it is deliberately not pursued as
a profitable product. The user's framing (2026-05-31): a commercial/proprietary
compiler in this niche would not be adopted by industry/runtimes/standards
bodies anyway, so **openness is the adoption strategy, not a sacrifice** — being
fully open is both more honest and the path to becoming durable infrastructure.

**How to apply:**
- Never describe js2wasm as a "product," "commercial," "enterprise," or
  "proprietary" offering in any public-facing doc (README, CONTRIBUTING, CLA,
  website, grant text). Frame it as an open foundation / public building block,
  Apache-2.0 WITH LLVM-exception.
- BUT the **CLA legal grant stays broad on purpose** — `CLA.md` line 5 grants
  relicensing "under any license terms," kept to preserve long-term
  funding/maintenance optionality. Do not narrow the grant; only keep the
  *framing/marketing* non-commercial. (Reconciles: don't advertise a commercial
  product, don't legally foreclose one.) See [[feedback_cla_gate.md]].
- Grant/open-source character is documented via "all source and funded
  deliverables released under Apache-2.0 with LLVM exceptions," not by claiming
  the org is non-commercial.
- The 2026-03-18 strategy doc's commercial-revenue framing is superseded
  (banner added); treat such planning history as historical only.
