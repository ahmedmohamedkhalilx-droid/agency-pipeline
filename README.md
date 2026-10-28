# agency-pipeline

A Claude Code pipeline that turns a client brief into a checked, reviewed small-business
website, plus a local dashboard that shows each run live.

```
CLAUDE.md                    rules every step follows
.claude/agents/              builder, visual-reviewer, niche-researcher
.claude/commands/            /build-client: the whole loop in one command
.claude/settings.json        hooks that feed the dashboard
checks/check.js              free Playwright QA (375 / 768 / 1440)
checks/visual-checklist.md   what the visual reviewer scores
niches/                      cached research, one file per niche
projects/_template/          copy this for each new client
dashboard/                   live run view (node canvas, log, screenshots)
```

## Setup

```bash
npm install
npx playwright install chromium
```

## Use

1. **New client:** copy `projects/_template/` to `projects/<client>/` (or click **+** in the
   dashboard), paste the client's WhatsApp messages into `project.json → brief.raw`, and fill
   in what you know. Put logos and photos in `assets/`.
2. **Run the pipeline:** open Claude Code in this folder and type `/build-client <client>`.
   It researches the niche (once), builds, runs the check, fixes (max 3 rounds), has
   the visual reviewer judge the screenshots, and writes a summary.
3. **Check only (no AI):** `node checks/check.js projects/<client>` or any URL / folder.
   Exit code 0 = pass, 1 = issues, 2 = script error. Report and screenshots go to `reports/`.

## Dashboard

```bash
node dashboard/server.js   # http://localhost:4321
```

(`npm run dashboard` does the same, but Windows PowerShell blocks `npm` when script
execution is disabled; `node` always works.) Keep that terminal open: the dashboard
stops when it closes. **Open site** previews the selected client's built website.

Runs show up live whether they're started from the dashboard or from Claude Code, because
the hooks in `.claude/settings.json` log every agent call, check run and file edit to
`.pipeline/events.jsonl`. The **Run pipeline** button needs the `claude` CLI to be signed in
(set `CLAUDE_BIN` if it isn't found automatically).

## Privacy

`projects/*` is git-ignored except the template, so client briefs, contact details and
assets stay on your machine.
