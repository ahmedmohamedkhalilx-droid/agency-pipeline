---
description: Run the full pipeline for one client: research → build → check/fix → visual review → summary
argument-hint: <client-folder-name>
---

Run the agency pipeline for `projects/$ARGUMENTS`. Follow `CLAUDE.md` throughout.

**Run every agent in the foreground and wait for its result.** Never launch an agent in
the background: each step needs the previous step's output, and in a one-shot run
(`claude -p`) background agents are cut off when your turn ends.

Run the check as exactly `node checks/check.js projects/$ARGUMENTS`, with nothing
chained before or after it (no `cd`, `;`, `echo`). It prints PASS/FAIL itself.

## 0. Preflight
- Confirm `projects/$ARGUMENTS/project.json` exists. If not, stop and say so (intake
  hasn't been done; copy `projects/_template/`).
- Read `project.json`. Note `niche`, `status`, open `bugs` and the last few `history`
  entries. If the site already exists, this is an **update run**: only work on open bugs
  or whatever the latest history/brief changes call for. Don't rebuild.

## 1. Niche research (only if missing)
- If `niches/<niche>.md` does **not** exist, use the `niche-researcher` agent to
  write it. If it exists, skip this step.

## 2. Build
- Use the `builder` agent: "first build" if `site/` is empty, otherwise "fix these:
  <open bugs>". Pass the client folder path.

## 3. Check & fix loop (max 3 rounds total, shared with step 4)
- Run `node checks/check.js projects/$ARGUMENTS` yourself and read the output.
- If it fails: give the builder the exact failures (type, page, width, selector) and
  have it fix only those. Re-run the check. That's one round.
- Track the round count. After round 3, stop the loop and go to step 5.

## 4. Visual review (only once check.js passes)
- Use the `visual-reviewer` agent on the client folder.
- If VERDICT is FAIL and rounds remain: add its FAILs to `bugs` in `project.json`,
  send them to the builder, re-run check.js (it must still pass), then review again.
  Each builder pass counts as a round.

## 5. Summary
- Set `project.json → status` to `"review-ready"` if the check passed and the review
  passed, otherwise `"needs-human"`. Append a `history` entry by `"build-client"`.
- Reply with:
  - Check result per width + links, and rounds used (n/3)
  - Visual review verdict and score
  - What's still failing and what you'd try next (if anything)
  - `open_questions` for the client
  - Any "CHECKLIST GAPS" the reviewer raised (candidates for `checks/visual-checklist.md`)
  - Path to the screenshots
