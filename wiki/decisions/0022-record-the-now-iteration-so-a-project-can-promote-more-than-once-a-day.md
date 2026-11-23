---
type: decision-context
title: 'Record the Now iteration so a project can promote more than once a day'
description: 'Record the Now iteration so a project can promote more than once a day'
tags: [decisions]
status: stable
---
# 0022. Record the Now iteration so a project can promote more than once a day

- **Status:** accepted
- **Date:** 2026-11-22
- **Issue:** #202
- **Amends:** how Now and Next are found, and the layout of `iteration promote`, in [ADR 0015](0015-derive-the-class-from-the-project-iteration-field.md)

## Context

ADR 0015 derives Now and Next from the dates of the project's Iteration field. Now is the iteration that holds today, as a UTC day, and Next is the first one that starts after today. An iteration lasts whole days, so `iteration promote` refused while Now had started today: Now could not end before today. A project could promote at most once per UTC day.

Goals are often shorter than that. On 2026-11-21 both projects were promoted in the morning, and both new Now goals were reached the same evening, at 21:39 and 23:03 UTC. Both promotes were refused, and the next goals waited for 00:00 UTC (#202). #121 raises the same limit as its first point, and adds that if nobody promotes for 365 days, Now ends on its own date and the CLI moves on without the coach.

A probe on a throwaway project on 2026-11-22 (recorded on #202) tested what the field can hold. Every write passed every id:

- **An iteration of zero days is refused.** GitHub returns `UNPROCESSABLE` with "Settings completed iterations duration must be greater than 0" and changes nothing.
- **Two iterations with the same start date overlap.** GitHub dropped one of them with no error and cleared its item. In the probe it kept the one listed first, a one-day iteration, and dropped the 365-day one after it.
- **The dates of completed iterations can be moved.** Their items keep their values.
- **A gap between iterations is kept.** The iterations around it keep their ids, dates and items, and a day in the gap has no current iteration.

So two goals cannot both be dated on the day they ran. Either the field holds a date that is not the close date, or a promote has to wait for the next day.

## Decision

**`iteration promote` records the new Now, and that record, not the date, says which iteration is Now.**

- **Where the pointer lives:** in the coordinator's state folder, in `now-pointers.json`. It holds the Now iteration's id per project, and the time `promote` set it. It is durable state, like `claims.db`, and not cache: the cache can be deleted and rebuilt from GitHub, and the pointer cannot.
- **Now** is the recorded iteration, whatever the date. **Next** is the first iteration that starts after it. An iteration that starts before Now is completed, and one after Next is planned.
- **No record:** a project with no entry, or one whose recorded id is no longer in the field, falls back to the dates of ADR 0015. So the change needs no migration: the first `promote` of each project writes its entry. `iteration list` reports which rule it used in its `pointer` key (`recorded` or `dates`), and it warns about a recorded id that is gone.
- **A file that cannot be read** (not JSON, or another version) stops every command that reads it with exit 1. A silent fallback to the dates could make a finished goal Now again.
- **`iteration promote` has no date check.** It ends Now today, as before. When Now started today or later, it gives Now one day instead, because a zero-day iteration is refused. Next starts where the last kept iteration ends, but not before today. The planned iterations follow back to back. Completed iterations are not moved.
- **It records the new Now once GitHub has taken the update,** even when the readback then fails, because the update is applied. The `reason` then says that Now is recorded, so that the coach runs `iteration list` before another promote.
- **Every write is checked before it is sent:** every existing id is in the layout, as before. In addition, every iteration lasts at least one day, and no iteration overlaps another.
- `ready`, `why` and `class` read the pointer. `sync` does not change it.

**What the Iteration field still records:**

- Which iteration each issue belonged to. A promote writes no item.
- The goal, as the iteration's title.
- The dates, as a log. A goal closed on a later day than the one before it ends on the day it closed. On a day with more than one promote, each later goal is dated one day after the one before it: the second goal of 2026-11-22 starts on 2026-11-23, and a third on 2026-11-24. The dates catch up when the promotes slow down.

## Compromise

**Where the pointer lives.**

- **Rejected: a project field on the items, such as a single-select `Goal` with Now, Next and Done.** It is not a pointer: a promote would write every item of the old Now and of Next. That is the problem that ADR 0015 moved away from (#95).
- **Rejected: the project README.** It is a free text that the coach and the `groom-road-blocks` scripts also write, and an edit in the web UI could drop a hidden marker with no error. A promote would make two GitHub writes, the field and the README, with a failure possible between them.
- **Rejected: back-dating, with no pointer.** The probe shows that GitHub keeps new dates on completed iterations, so a same-day promote could move the old Now, and every completed iteration that it would overlap, into the past. GitHub's `@current` would then always match Now. But it rewrites the history on each extra promote. A goal that runs 365 days would still end on its date with no coach decision (#121). And Now could never be an iteration that does not hold today, which the acceptance criteria of #202 require.
- **Chosen: the coordinator's state.** It is one small file that `promote` writes after the field. The CLI is the only reader, and the coach skill reads Now and Next through the CLI. The cost: the record is on one machine. GitHub's views use the dates, so after a same-day promote, the board's `@current` shows the earlier goal until the dates catch up. A lost file falls back to the dates, which name the right Now again by the next day at the latest, unless several promotes ran on one day.

**The layout of a same-day promote.**

- **Rejected: back-date the completed iterations.** See above. It also moves dates that the README's iteration history already cites.
- **Chosen: date the new Now forward.** The completed iterations are never rewritten. The cost: the dates of a busy day are off by the number of extra promotes.

## Consequences

- ADR 0015 Consequences: "`promote` refuses when Now started today" no longer holds.
- The `iteration close` of #190 can become "record no Now", with Next as the first iteration after the closed one. The probe already shows that GitHub keeps a gap, which #190 asked a probe for.
- A worktree that checks a criterion against a copy of the live state copies `now-pointers.json` with `cache.db` and `claims.db`.
- The `groom-road-blocks` skill no longer waits for 00:00 UTC to promote. Its `next-readback.mjs` reads Now and Next from `iteration list --json`, not from the dates.
- The coach skill of the `gvt-fleet` plugin may still tell the coach to wait for 00:00 UTC. That skill ships from another repository, so it is a follow-up there.
