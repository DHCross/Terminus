# Sherlog Operational Boundary Policy

## Axiom

If Sherlog causes surprise, it is already doing too much.

Sherlog is a diagnostic layer. It is not a repo-shaping actor.

## Allowed

- Read git history, diffs, and repository structure.
- Run explicit preflight commands when a human asks for them.
- Generate gap reports, doctor output, prompts, bounds, skill suggestions, and similar analysis artifacts.
- Write only to Sherlog-owned data and artifact locations.
- Update Sherlog-owned config only when explicitly invoked for Sherlog setup or repair.
- Produce temporary analysis output clearly scoped to Sherlog artifacts.
- Be used before major edits, refactors, or review passes to improve context quality.
- Be used as an occasional hygiene scanner, not ambient background machinery.

## Not Allowed

- Create, remove, or manage git worktrees.
- Create helper branches, detached branches, or temporary repos.
- Modify `.code-workspace` files.
- Modify IDE-specific workspace files (Antigravity, VS Code, Claude, or similar).
- Run automatically in the background on every task.
- Rewrite repository structure, move files, or reorganize source trees unless explicitly requested.
- Quietly patch package scripts, AGENTS files, repository instructions, or workflow files unless the user requested Sherlog maintenance.
- Touch non-Sherlog generated files just because they appear in analysis output.
- Become part of commit, branch, or workspace lifecycle automation by default.

## Default Operating Mode

- Sherlog is manual, not ambient.
- Invoke it before substantial work, not during every small edit.
- Treat outputs as advisory unless the user explicitly asks to apply Sherlog-driven changes.
- Prefer read-only usage unless a command explicitly updates Sherlog-owned state.

## Safe Command Set

Normal scope:

- `verify`
- `doctor`
- `gaps`
- `prompt`
- `bounds`
- `hygiene`
- `skills:suggest`

Higher-friction, opt-in only:

- `init-context`
- `index-sync`
- `skills:generate`
- `bridge`
- Any command that rewrites Sherlog config or generated indices.

## Hard Boundaries

- Git topology belongs to the human or coding agent, not Sherlog.
- IDE/workspace topology belongs to the human, not Sherlog.
- Sherlog may observe repository structure; it may not govern repository structure.
- Sherlog may emit artifacts; it may not silently expand its operational footprint.

## Practical Stop Rule

If a Sherlog action would change any of the following, stop unless explicitly requested:

- Branches
- Worktrees
- Workspace files
- Editor settings
- CI/workflow behavior
- Package scripts outside Sherlog's own install/maintenance path

## Repo Intent

Sherlog is for:

- Tell me what I am missing.
- Tell me where the risk is.
- Help me frame the task.
- Help me inspect structural drift.
- Help me generate a better prompt.

Sherlog is not for:

- Manage my IDE.
- Manage my git topology.
- Manage my active branches.
- Continuously mutate repository metadata.
- Run as an invisible operator behind the scenes.

## Recommended Stance

- Keep Sherlog installed.
- Use it deliberately.
- Keep it out of workspace management.
- Keep it out of worktree management.
- Keep it out of background automation.
- Treat it as a sharp instrument, not infrastructure.
