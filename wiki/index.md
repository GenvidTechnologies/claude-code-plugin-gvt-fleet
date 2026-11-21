---
okf_version: "0.2"
---

# Wiki Index

This wiki is the documentation of the `gvt-fleet` plugin. It lists every page under `wiki/`, grouped under section headings, one line each. Each entry's text is the linked page's frontmatter `description`. The page format and the maintenance rules are in [the schema](schema.md). The change log is [log.md](log.md).

## Process

* [Issue Triage Conventions](issue-triage.md) - Project conventions that /gvt-dev:triage-issues reads: types, priorities, class, road block, labels, required fields, splitting, duplicates, dependencies and mutation recipes.

## Decisions

* [Decision Records](decisions/index.md) - The decision records of this plugin, in MADR-lite format.
* [0001. Run the triage pass in the coach session](decisions/0001-run-the-triage-pass-in-the-coach-session.md) - The coach skill runs the triage pass in the coach session, one repository at a time from its base clone, with a wrong-repository guard, no file writes and the coach approving each change.

## Schema

* [Wiki Maintenance Schema](schema.md) - The maintenance rules for this wiki: page format, links, the locations of the triage contract and the decision records, create-vs-update lifecycle, staleness policy and the verb contract.
