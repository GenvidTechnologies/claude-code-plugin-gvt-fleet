# Decision Records

The decision records of this plugin, in MADR-lite format. Each record is a wiki page (`type: decision-context`). `.gvt-agent.json` points `paths['docs/decisions/']` at this folder, so `/gvt-dev:create-adr` writes new records here. Do not hand-number files. The [wiki index](../index.md) links this list.

## Records

* [Run the triage pass in the coach session](0001-run-the-triage-pass-in-the-coach-session.md) - The coach skill runs the triage pass in the coach session, one repository at a time from its base clone, with a wrong-repository guard, no file writes and the coach approving each change.
