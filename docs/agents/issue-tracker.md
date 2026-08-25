# Issue tracker: GitHub

Issues and specs for this repo live in `devosurf/migmate-cli` on GitHub. Use the `gh` CLI with `-R devosurf/migmate-cli` to scope every operation explicitly.

## Conventions

- **Create an issue**: `gh issue create -R devosurf/migmate-cli --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view -R devosurf/migmate-cli <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list -R devosurf/migmate-cli --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment -R devosurf/migmate-cli <number> --body "..."`
- **Apply / remove labels**: `gh issue edit -R devosurf/migmate-cli <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close -R devosurf/migmate-cli <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view -R devosurf/migmate-cli <number> --comments` and `gh pr diff -R devosurf/migmate-cli <number>`.
- **List external PRs for triage**: `gh pr list -R devosurf/migmate-cli --state open --json number,title,body,labels,author,authorAssociation,comments`, then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment / label / close**: use `gh pr comment`, `gh pr edit`, and `gh pr close` with `-R devosurf/migmate-cli`.

GitHub shares one number space across issues and PRs, so resolve a bare `#42` with `gh pr view -R devosurf/migmate-cli 42` and fall back to `gh issue view -R devosurf/migmate-cli 42`.

## When a skill says "publish to the issue tracker"

Create an issue in `devosurf/migmate-cli`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view -R devosurf/migmate-cli <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The map is a single issue with child issues as tickets.

- **Map**: an issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog body.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Where sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body.
- **Blocking**: use GitHub issue dependencies through `repos/devosurf/migmate-cli/issues/<child>/dependencies/blocked_by`. Where dependencies are unavailable, use a `Blocked by: #<n>, #<n>` line.
- **Frontier query**: list the map's open children, then drop tickets with an open blocker or assignee; first in map order wins.
- **Claim**: `gh issue edit -R devosurf/migmate-cli <n> --add-assignee @me`.
- **Resolve**: comment with the answer, close the ticket, then append its context pointer to the map's Decisions-so-far.
