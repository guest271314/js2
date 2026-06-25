# ts2wasm Project Memory

## CRITICAL RULES (check every time)
- **ALWAYS spawn agents as teammates** (team_name + isolation:worktree), NOT bare subagents.
- **Max ~3 dev agents + 1 PO**, bypassPermissions + worktree isolation. CPU is the binding limit (~cores−2 active).
- **BEFORE EVERY git add/commit**: `pwd && git branch --show-current` — agent worktrees change cwd silently.
- **NEVER `git add -A`** — stages worktree artifacts. Stage specific files.
- **NEVER delete worktrees without checking `git -C <wt> diff --stat` first + asking.**
- **NEVER work on agent branches/worktrees** — verify pwd=/workspace before edits/commits.
- **NEVER kill running tests without asking.**
- **NEVER comment on/close/reopen external-user GitHub issues, and NEVER `gh issue create`** — track in `plan/issues/`. See [feedback_no_github_issue_comments.md](feedback_no_github_issue_comments.md).
- **NEVER force-push/rewrite published `main`** — append-only; fix forward via revert PRs. See [feedback_public_main_append_only.md](feedback_public_main_append_only.md).
- **NEVER merge external-contributor PR without recorded CLA acceptance** (cla-check is a stub). See [feedback_cla_gate.md](feedback_cla_gate.md).
- **Mimic standard Node.js / Web Worker APIs; no bespoke builtins.** See [feedback_mimic_node_worker_apis.md](feedback_mimic_node_worker_apis.md).
- **PR titles `type(scope): summary`; Codex branches `codex/<id>-<slug>` + co-author trailer.** See [feedback_pr_title_coauthor_conventions.md](feedback_pr_title_coauthor_conventions.md).

## Single source of truth
- Team setup, memory budget, spawn config, comms: **`plan/method/team-setup.md`**. Agent defs: **`.claude/agents/`**. Most context: **`/workspace/CLAUDE.md`**.
- Memory files store only prefs/feedback not in repo files.

## Memory Index

### User & project
- [user_role.md](user_role.md) — Project lead: challenges assumptions, thinks in compilation strategies
- [project_team_setup.md](project_team_setup.md) — All agents as teammates; details in plan/method/team-setup.md
- [project_proxy_no_ts_type_brand.md](project_proxy_no_ts_type_brand.md) — A JS Proxy carries no TS-type brand; detect syntactically + defer to host (#2501)
- [project_2602_forof_assign_rest_write_unimplemented.md](project_2602_forof_assign_rest_write_unimplemented.md) — #2602: for-of/for-await assignment-destructuring rest write unimplemented (loops.ts); blocks #2580 M2
- [project_linear_backend_no_console_log.md](project_linear_backend_no_console_log.md) — Linear backend drops console.log; assert return values not stdout (#1854)
- [project_bigint_i64_brand_gate.md](project_bigint_i64_brand_gate.md) — BigInt fixes gated on architect i64-brand ValType decision

### Team, agents & dispatch (rules not in plan/method/)
- [feedback_dev_agents_worktree.md](feedback_dev_agents_worktree.md) — ALL writing agents must use worktree isolation
- [feedback_architect_worktree_isolation.md](feedback_architect_worktree_isolation.md) — Architects stall without isolation:worktree
- [feedback_bypass_permissions.md](feedback_bypass_permissions.md) — Always bypassPermissions when spawning
- [feedback_dev_limit.md](feedback_dev_limit.md) — Max 4 devs as teammates; test naming; merge method
- [feedback_dev_self_serve_tasklist.md](feedback_dev_self_serve_tasklist.md) — Devs claim next task from TaskList after merge
- [feedback_tasklist_always_populated.md](feedback_tasklist_always_populated.md) — Populate TaskList at sprint start + on every new issue; empty = idle
- [feedback_tasklist_sync_unreliable.md](feedback_tasklist_sync_unreliable.md) — Native auto-dispatch canonical; lead reconciles (mark merged done now)
- [feedback_sendmessage_discipline.md](feedback_sendmessage_discipline.md) — SendMessage = blockers/decisions/completions only; else TaskUpdate/silence
- [feedback_dev_silence_protocol.md](feedback_dev_silence_protocol.md) — Devs silent during CI-wait; don't poke; escalate only
- [feedback_idle_notification_silence.md](feedback_idle_notification_silence.md) — Idle ping = STATE signal: resolve (task/shutdown/stale), don't just go silent
- [feedback_agent_self_termination.md](feedback_agent_self_termination.md) — Agents idle after finishing; include kill-pane in spawn prompts
- [feedback_dedicated_pr_shepherd.md](feedback_dedicated_pr_shepherd.md) — Staff a standing PR-queue shepherd; don't hand-shepherd ad-hoc
- [feedback_lead_shepherds_prs.md](feedback_lead_shepherds_prs.md) — Lead shepherds every loop: one-shot enqueue CLEAN PRs; auto-enqueue is backstop only
- [feedback_auto_ff_workspace_main.md](feedback_auto_ff_workspace_main.md) — Auto-ff /workspace to origin/main; stale tree gives wrong sprint counts
- [feedback_slice_claim_collision_check_assignments_log.md](feedback_slice_claim_collision_check_assignments_log.md) — Slice claims double-dispatch; check issue-assignments log for sole ownership
- [feedback_dispatch_status.md](feedback_dispatch_status.md) — Set issue in-progress when dispatching
- [feedback_context_discipline.md](feedback_context_discipline.md) — Don't re-check state; split planning/execution; write handoffs to plan/agent-context/
- [feedback_token_budget_guardrails.md](feedback_token_budget_guardrails.md) — Weekly budget: warn 25%, break 40%, hard stop 50%
- [feedback_budget_is_own_agents_pipeline_not_idle.md](feedback_budget_is_own_agents_pipeline_not_idle.md) — My budget = my agents; pipeline next slice during CI-wait, don't idle-poll
- [feedback_diary_and_sprints_before_compact.md](feedback_diary_and_sprints_before_compact.md) — Update diary + sprint doc/retro BEFORE /compact
- [feedback_compact_before_sprint.md](feedback_compact_before_sprint.md) — /compact at sprint boundaries
- [feedback_devs_default_opus.md](feedback_devs_default_opus.md) — Devs/sendevs/architects default opus; don't downgrade without OK
- [feedback_sonnet_for_sprint_loop.md](feedback_sonnet_for_sprint_loop.md) — Sonnet for routine lead loop; Opus for crisis/architecture
- [feedback_background_teammate_shutdown_limitation.md](feedback_background_teammate_shutdown_limitation.md) — BG teammates can't complete shutdown handshake; clear on lead-session-end
- [feedback_dont_ask_continue.md](feedback_dont_ask_continue.md) — Keep dispatching; don't pause to ask
- [feedback_wait_for_answer.md](feedback_wait_for_answer.md) — Ask then STOP; never act on assumed "yes"

### Merge / CI / queue
- [feedback_lead_shepherds_prs.md](feedback_lead_shepherds_prs.md) — (see above) enqueue user-PAT one-shot, NEVER re-enqueue (loop hazard)
- [feedback_merge_queue_wedge_recovery.md](feedback_merge_queue_wedge_recovery.md) — Recover wedged queue (stuck AWAITING_CHECKS) by dequeue+re-enqueue
- [feedback_batch_doc_commits_before_pr_push.md](feedback_batch_doc_commits_before_pr_push.md) — Batch doc commits into first PR push; 2nd commit re-triggers full CI
- [feedback_branch_from_upstream_main_not_fork.md](feedback_branch_from_upstream_main_not_fork.md) — Branch from origin/main (post-fetch), never stale fork
- [feedback_no_duplicate_issue_dispatch.md](feedback_no_duplicate_issue_dispatch.md) — Verify issue isn't already on main / fixed by open PR before dispatch
- [feedback_no_shared_worktree_assignment.md](feedback_no_shared_worktree_assignment.md) — Never assign two agents to same branch/worktree
- [feedback_shared_worktree_clobber_check_claim_first.md](feedback_shared_worktree_clobber_check_claim_first.md) — Check claim lock by ISSUE id before editing a shared branch
- [feedback_cla_check_rerun_after_merge_commit.md](feedback_cla_check_rerun_after_merge_commit.md) — Fork PR cla-check fails after merge commit; gh run rerun it
- [reference_baseline_gates_need_postmerge_autorefresh.md](reference_baseline_gates_need_postmerge_autorefresh.md) — Prescriptive baseline gates must self-refresh post-merge or wedge all PRs
- [reference_gh_remove_label_rest_not_pr_edit.md](reference_gh_remove_label_rest_not_pr_edit.md) — gh pr edit --remove-label no-ops; use REST API for labels

### Issue management
- [feedback_issue_completion.md](feedback_issue_completion.md) — Completion: move, frontmatter, summary, log, unblock
- [feedback_unblock_on_completion.md](feedback_unblock_on_completion.md) — After done: grep depends_on, flip blocked/backlog→ready
- [feedback_document_findings.md](feedback_document_findings.md) — Document agent findings in issue files before closing
- [feedback_update_backlog.md](feedback_update_backlog.md) — Update backlog.md on issue create/complete
- [feedback_po_boundary.md](feedback_po_boundary.md) — PO only writes to plan/
- [feedback_bare_numbers_are_plan_tasks.md](feedback_bare_numbers_are_plan_tasks.md) — Bare numbers = local plan issues unless user says GitHub
- [feedback_dispatch_against_upstream_not_stale_fork.md](feedback_dispatch_against_upstream_not_stale_fork.md) — Dispatch from upstream/main probes, not stale fork frontmatter

### Testing & CI gates
- [project_standalone_floor_only_on_merge_group.md](project_standalone_floor_only_on_merge_group.md) — Standalone floor #2097 runs only in merge_group, not PR; bisect via jsonl diff
- [project_broad_impact_validate_full_ci.md](project_broad_impact_validate_full_ci.md) — Broad-impact changes need full local-ci/merge_group, NEVER scoped sweep (hides regressions)
- [feedback_baseline_drift_cross_check.md](feedback_baseline_drift_cross_check.md) — Identical regression clusters across unrelated PRs = drift, not real
- [feedback_regression_analysis.md](feedback_regression_analysis.md) — Regressions may be false-positive exposure; pass→compile_timeout is flake
- [feedback_test262_worktree.md](feedback_test262_worktree.md) — Test262 in worktree, not main wc
- [feedback_worktree_symlink_dependencies.md](feedback_worktree_symlink_dependencies.md) — Symlink test262 + node_modules into new worktrees
- [feedback_test262_recheck.md](feedback_test262_recheck.md) — Default --recheck for test262, npm test for vitest
- [feedback_test262_skip_issues.md](feedback_test262_skip_issues.md) — Every skip filter needs an issue
- [feedback_never_delete_test_data.md](feedback_never_delete_test_data.md) — Never delete test data/cache/runs without asking
- [feedback_trigger_deploy_pages.md](feedback_trigger_deploy_pages.md) — After [skip ci] baseline refresh, trigger deploy-pages.yml
- [project_wrapforhost_setexports_harness.md](project_wrapforhost_setexports_harness.md) — Host-closure probes need imports.setExports(instance.exports) after instantiate
- [reference_error_analysis.md](reference_error_analysis.md) — Test262 error analysis procedure
- [reference_standalone_harvest_rootcausemap_mislabeled.md](reference_standalone_harvest_rootcausemap_mislabeled.md) — Harvest root_cause_map buckets unreliable; bucket from jsonl signatures

### Development methodology
- [feedback_verify_first_beats_architect_spec.md](feedback_verify_first_beats_architect_spec.md) — Verify mechanism per-process (binaryen WAT) on current main before implementing; deep-tracing devs beat architect-specs; verified scope+handoff is valid
- [feedback_reground_spec_against_current_main.md](feedback_reground_spec_against_current_main.md) — Re-probe failure on CURRENT main before implementing; sibling PRs move the path
- [feedback_verify_fix_in_git_not_narrative.md](feedback_verify_fix_in_git_not_narrative.md) — Verify fixes against git ancestry + test presence, not session narrative
- [feedback_spec_first_fixes.md](feedback_spec_first_fixes.md) — Fetch the ECMAScript spec before fixing; cite section in commits
- [feedback_no_adhoc_scripts.md](feedback_no_adhoc_scripts.md) — Use existing scripts, never ad-hoc Python
- [feedback_nothing_impossible.md](feedback_nothing_impossible.md) — Don't label features impossible — find the compilation strategy
- [feedback_compile_away.md](feedback_compile_away.md) — Resolve JS semantics statically, zero runtime overhead
- [feedback_refactoring_failures.md](feedback_refactoring_failures.md) — After refactoring: check missing imports first, not circular deps
- [project_type_index_shift_and_deadelim.md](project_type_index_shift_and_deadelim.md) — Dead-elim remaps WasmGC type idx; register shared types late+once
- [project_brand_check_swap_savedbodies.md](project_brand_check_swap_savedbodies.md) — fctx.body swaps capturing a branch must use pushBody/popBody (#2563)
- [reference_no_rebuild_helper_body_at_finalize.md](reference_no_rebuild_helper_body_at_finalize.md) — Never rebuild a native-helper body at finalize (breaks late-import shift); splice
- [reference_shared_instr_object_dce_double_remap.md](reference_shared_instr_object_dce_double_remap.md) — Never alias one Instr[] into two branches — DCE double-remaps type idx; fresh arm per branch
- [reference_subview_type_idx_stability.md](reference_subview_type_idx_stability.md) — Reserve hoist-surviving struct types in up-front type-init, not on-demand

### Active substrate (s66 carry)
- [project_next_session.md](project_next_session.md) — Session-state pointer: s65 CLOSED/tagged, s66 active; verified critical-path levers (#2651 builtin-ctor-value, #2580 M3, inbound keystone, #2637)
- [project_standalone_any_string_value_read_substrate.md](project_standalone_any_string_value_read_substrate.md) — Standalone $Object dynamic any-typed reader drops native-string VALUES — root of many standalone gaps; value-rep
- [project_2040_tag5_classifier_dstr_default_regression.md](project_2040_tag5_classifier_dstr_default_regression.md) — #1888 tag-5 field-4 eq: restore ref.test $AnyString guard, DEFER classifier (both #2040 numeric + #2585 object regress dstr) → #2580 M2
- [project_wasm_linking_core_over_component.md](project_wasm_linking_core_over_component.md) — Modularize via core-wasm linking (#2527), not Component Model
- [project_standalone_hostimport_gate_index_shift.md](project_standalone_hostimport_gate_index_shift.md) — Gating lib-global host-import under standalone reorders import/type table → wrong idx

### General behavior
- [feedback_ask_role.md](feedback_ask_role.md) — Ask at start: Tech Lead or Product Owner
- [feedback_ask_ralph_loop.md](feedback_ask_ralph_loop.md) — Ask if Ralph loop should start
- [feedback_external_comments_first_person.md](feedback_external_comments_first_person.md) — External comments first-person singular ("I"), never "we"
- [feedback_no_nuclear_option.md](feedback_no_nuclear_option.md) — Never take destructive shortcuts without consent
- [feedback_check_before_cleanup.md](feedback_check_before_cleanup.md) — Check worktree diffs before removing
- [feedback_explicit_main_push.md](feedback_explicit_main_push.md) — Push to main only when user explicitly asks each time
- [feedback_no_git_stash_in_worktree.md](feedback_no_git_stash_in_worktree.md) — NEVER git stash in a worktree (shared stack; concurrent agents clobber)
- [feedback_no_git_stash_shared_worktree_conflict_markers.md](feedback_no_git_stash_shared_worktree_conflict_markers.md) — Never stash/pop to A/B-test; injects conflict markers into others' files
- [feedback_no_stash_before_merge.md](feedback_no_stash_before_merge.md) — Never stash before merge, commit first
- [feedback_sprint_tags.md](feedback_sprint_tags.md) — Tag sprint-N/begin at start, sprint/N at end
- [feedback_sprint_status_format.md](feedback_sprint_status_format.md) — Sprint status format: `s52: 17/82 done`
- [reference_git_corrupt_loose_object_refetch.md](reference_git_corrupt_loose_object_refetch.md) — Recover corrupt loose object via git fetch --refetch
- [feedback_mimic_node_worker_apis.md](feedback_mimic_node_worker_apis.md) — Expose standard Node/Web Worker APIs, compile to WASI; no bespoke builtins

### Closed-issue root-cause notes (s60–s65, kept on disk, dropped from index to fit the load limit)
Individual `reference_*` / `project_*` files for specific closed issues remain in this directory (e.g. #1355, #1461, #1472, #1629b, #1910, #2026, #2042, #2101a, #2151, #2186, #2190, #2191, #2193, #2203, #2358, #2372, #2375, #2379, #2515, #2524, #2552, #2554, #2583). They were one-off codegen root-causes now captured in git history + issue files. Grep this dir by issue number when revisiting one. Promote any that resurface as active back into a section above.
