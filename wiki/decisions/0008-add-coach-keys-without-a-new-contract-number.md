---
type: decision-context
title: 'Add coach keys without a new contract number'
description: 'Add coach keys without a new contract number'
tags: [decisions]
status: stable
---
# 0008. Add coach keys without a new contract number

- **Status:** accepted
- **Date:** 2026-11-06
- **Issue:** #32 (`ready` does not show how many issues wait only for the `triaged` label)

## Context

`gvt-fleet ready --json` gains the key `untriaged`, a summary of the open issues that have the reason `not-triaged`. The coach skill reads the JSON keys listed in "The coach skill contract" in `wiki/coordinator/coach-skill-contract.md`. `COACH_CONTRACT` in `lib/dispatch.mjs` is the version number of that contract, and it is now 1. Each installed coach skill refuses any number other than the one it was written for.

The rule so far said that the number goes up when a listed key is removed, renamed, or changes type or meaning. It said that adding a key that the skill does not read needs no new number. It did not say what happens when the skill does read the new key. The skill that will read `untriaged` is GenvidTechnologies/claude-code-plugin-gvt-fleet#3.

## Decision

Adding a key never raises the contract number. `COACH_CONTRACT` stays 1 when `untriaged` is added.

A coach skill that reads a key added after the contract it was written for treats a missing key as "not reported". A missing key is not the same as an empty array. `untriaged` is always present on a CLI that has it, and it is `[]` when no issue is untriaged. A skill run against an older CLI finds the key missing and does not report an untriaged summary.

The new keys are listed in the contract table and in "When each key is present" in `wiki/coordinator/coach-skill-contract.md`. `test/coach-contract.test.mjs` pins them.

## Compromise

**Rejected: raise the contract number to 2.** Every installed coach skill is pinned to 1, so each would refuse to run until the plugin ships a contract-2 release. The CLI and the plugin would have to release together, for a key that only adds information. The number is a gate for changes that break a reader, and an added key breaks none.

**Accepted limit.** The number no longer tells a skill whether a key exists. A skill that needs a key added later must handle its absence itself, and nothing in the CLI warns it. The rule moves that check into each skill.

## Consequences

- An old coach skill keeps working with a new CLI. It ignores the key.
- A new coach skill works with an old CLI. It reports no untriaged summary.
- Removing a key, renaming it, or changing its type or meaning still raises the number, together with `test/coach-contract.test.mjs` and the contract section.
- Rule 2 of "The coach skill contract" and the `contract` bullet of `check-config` state this rule.
