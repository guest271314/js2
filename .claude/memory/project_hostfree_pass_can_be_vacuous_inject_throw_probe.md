---
name: project_hostfree_pass_can_be_vacuous_inject_throw_probe
description: "host-free pass ≠ genuinely-executed — leak-elim fixes must prove test bodies execute (inject-throw probe) or they dishonestly inflate the standalone metric (#2921 harness-wrapper class)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**host-free ≠ genuinely-executed.** The honest standalone metric (`host_free_pass` = status pass AND zero `env::` imports) can still be inflated by *vacuous* passes: tests whose callback/wrapper body is never invoked. Found 2026-07-02 on #2921: the test262 `testWith*TypedArrayConstructors(function(TA){...})` wrapper callbacks take the host `__make_callback` path and are never invoked in standalone — all assertions are dead code. Removing only the import (shim fix) makes the test host-free while the body STILL never runs → a dishonest host-free pass.

**Why:** the leak was the only thing excluding these vacuous passes from the honest count. Eliminating a leak without making the body execute converts leaky-vacuous → host-free-vacuous, silently inflating `host_free_pass`.

**How to apply:** any leak-elimination PR must prove the affected test bodies actually EXECUTE, not just that the import disappears. Standard probe: inject `throw new Error('RAN')` (or a log) as the first statement of the callback/wrapper body — if the test still passes, the body is dead and the "fix" is dishonest. Also output-diff standalone vs js-host on a sample. Root blocker for the #2921 class: dynamic dispatch of `any`-typed closure params requires exact arity+kind match (`src/codegen/expressions/calls-closures.ts` ~L688 exact-arity continue + L693-698 kind check) instead of JS arity semantics; fix routed to senior lane. Related: [[reference_standalone_any_string_value_read_substrate]].
