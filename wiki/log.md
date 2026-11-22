# Wiki Log

Record of every change to the wiki's page set: what changed, why, and which source drove it, grouped under `## YYYY-MM-DD` date headings (ISO 8601) with the newest date group first. Entries are prose bullets, for example `* **Update**: …`, `* **Creation**: …`, `* **Deprecation**: …`.

Add newest first. Never edit or remove a prior entry. If a past entry needs a correction, add a new entry that says so. The maintenance rules are in [the schema](schema.md).

## 2026-11-22

* **Update**: `wiki/issue-triage.md`, Dependencies (retro of #38). When an acceptance row needs a part that the body leaves to another open issue, the body says whether the issue takes the part or waits for it. No `raw/` capture drove this run: the source is the work on #38.
* **Update**: `wiki/issue-triage.md` (retro of the triage of #75). Required fields says that an acceptance row that pledges one failing case per rule checks that each rule can fail on its own, and that a reason that states a fact about the environment is checked. Road block says that no Class field is written for an issue that "Set road block" adds to the project. No `raw/` capture drove this run: the source is the triage of #75.

## 2026-11-21

* **Update**: `wiki/issue-triage.md`, Required fields (retro of #37). An issue that has the skill write an issue reference into text says which form the text needs, because a closing keyword needs `owner/name#N`. The paragraph on where a worker's wording came from now says that the skill passes its composed prompt when the coach gives none, instead of "until #37 ships". No `raw/` capture drove this run: the source is the work on #37.
* **Update**: `wiki/issue-triage.md`, "Fold into an open issue" (retro of the triage of #65). When the folded issue reports the same events as the open issue from another worker's side, its account goes in the open issue's Evidence, and two accounts that differ are both kept. No `raw/` capture drove this run: the source is the fold of #65 into #62.
* **Update**: `wiki/issue-triage.md`. Required fields says that an acceptance row that limits the paths a file may name says which repository's paths it means. No `raw/` capture drove this run: the source is the retro of #33 on 2026-11-21.
* **Creation**: `wiki/schema.md`, `wiki/index.md`, `wiki/log.md` and `wiki/decisions/index.md` (issue #33). The schema is the `maintain-wiki` template with a "This project" paragraph that names the locations of the triage contract and the decision records. No `raw/` capture drove this run: the source is issue #33.
* **Creation**: `wiki/issue-triage.md` (issue #33). Moved from `docs/issue-triage.md`, with OKF frontmatter added. The body is unchanged. `.gvt-agent.json` sets `paths['docs/issue-triage.md']` to the new place, so `/gvt-dev:triage-issues` finds it. No `raw/` capture drove this run: the source is issue #33.
* **Creation**: `wiki/decisions/0001-run-the-triage-pass-in-the-coach-session.md` (issue #33). Moved from `docs/decisions/`, with OKF frontmatter added. The record had none. The body is unchanged. `.gvt-agent.json` sets `paths['docs/decisions/']` to `wiki/decisions/`, so `/gvt-dev:create-adr` writes new records there. No `raw/` capture drove this run: the source is issue #33.
