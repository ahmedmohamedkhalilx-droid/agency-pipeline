# Agency pipeline — rules every step follows

This folder builds small-business websites for clients. Each client lives in
`projects/<client>/`. `projects/_template/` is the starting point for a new one.

## The shared file
- **Always read `projects/<client>/project.json` first.** It holds the brief,
  brand, specs, open bugs and history. Don't work from memory of an earlier run.
- **After every change, append to `history`** in `project.json`:
  `{ "at": "<ISO date>", "by": "<agent or 'human'>", "did": "<one line>", "files": [...] }`.
- Keep `bugs` current: add what the check or reviewer found, set `"status": "fixed"`
  when it's fixed. Never delete entries.

## Editing the site
- **Edit only the files that need changing. Never regenerate the whole site**, even
  if it seems faster. A fix is a targeted Edit, not a rewrite.
- The site lives in `projects/<client>/site/`. Default stack is plain static
  HTML/CSS/JS with `site/index.html` at the root, unless `specs.stack` says
  otherwise. If a framework is used, build it to `site/out/` (or `dist/`) before checking.

## Checking
- **After every change, run** `node checks/check.js projects/<client>` and fix what
  it reports. Results land in `projects/<client>/reports/` (`report.json` + one
  screenshot per page per width: 375, 768, 1440).
- Exit code 0 = pass, 1 = issues, 2 = the script broke (fix the setup, not the site).
- **Stop after 3 fix rounds.** One round = fix → re-run the check. If it still
  fails after round 3, stop and write a short summary of what's still failing, why,
  and what you'd try next. Record it in `history`.
- Only once the check passes does the `visual-reviewer` look at the screenshots.

## Brand
- **Use the client's exact colors and assets from `assets/` and `project.json → brand`.
  Never invent brand colors.** If a color, font or logo is missing, use a neutral
  placeholder and add it to `open_questions` in `project.json`. Don't guess.
- Use real copy from the brief. Mark anything you had to write yourself with
  `<!-- TODO: confirm copy -->` and list it in `open_questions`.

## Agents (`.claude/agents/`)
- `niche-researcher`: writes `niches/<niche>.md`. Runs **only if that file doesn't
  exist yet**. Otherwise read the existing file.
- `builder`: builds and edits `site/` from `project.json` and `niches/<niche>.md`.
- `visual-reviewer`: judges the screenshots against `checks/visual-checklist.md`.
  Read-only; it reports problems, the builder fixes them.

## Intake (done by the human for now)
Client WhatsApp messages get pasted in and turned into `project.json` following
`projects/_template/project.json`. Keep the client's own words in `brief.raw`.

## Dashboard
`npm run dashboard` → http://localhost:4321. Hooks in `.claude/settings.json` send
every pipeline step to `.pipeline/events.jsonl` through `dashboard/hook.js`, so runs show
up live wherever they were started. Don't remove those hooks.

## Full loop
`/build-client <client>` runs everything: research (if needed) → build → check/fix
(max 3 rounds) → visual review → fix (counts toward the same 3 rounds) → summary.
