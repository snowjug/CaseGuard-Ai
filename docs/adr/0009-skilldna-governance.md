# ADR 0009: Governed SkillDNA lifecycle: distinct approver, optimistic locking, no auto-publish

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

A SkillDNA captures reusable investigation reasoning extracted from a case. A wrong or poisoned skill
propagates bad advice to every engineer who applies it (AI-6), and extraction is partly model-assisted. Skills
must therefore be governed like code that ships, not like notes (FR-GV-01).

## Decision

- **An explicit lifecycle**: `discovered`, `draft`, `simulation_tested`, `expert_reviewed`, `pilot`,
  `validated`, `published`, `deprecated`, `retired`, with simulation testing and expert review ahead of pilot and
  publication.
- **Distinct approver.** Approval requires a different person from the creator or requester; the deny-by-default
  permission matrix separates extract, mutate, validate, review, approve, publish, retire and rollback.
- **Optimistic locking.** Every transition and decision carries the `version` the caller last saw; a stale
  version is rejected, so two reviewers cannot silently overwrite each other.
- **No auto-publish.** Neither a model nor a score can publish a skill; publication is a human action that is
  audited (ADR 0008).
- **Versioned content with mutation and rollback.** Skill content lives in versions (`proposed`, `active`,
  `superseded`, `rejected`). Improvements arrive as proposed mutations that go through the same gates, and a
  rollback re-activates a previous version instead of editing history.
- **Honest effectiveness.** Reported improvement is measured on authored synthetic cases and labelled as a
  demonstration of the measurement pipeline, not real-world effectiveness (A-10).

## Consequences

- Good: a bad skill needs several independent humans and a passing simulation to reach users, every step is
  attributable, and any version can be rolled back.
- Bad: slower than letting a model publish; the process needs at least two people with the right roles, which
  is a staffing assumption for real use; the lifecycle adds states the UI must explain clearly.

## Alternatives considered

- **Self-approval or auto-approval above a score threshold:** one compromised or mistaken actor, or one
  overconfident model estimate, could publish unsafe guidance.
- **A simpler draft/published flag:** no place for simulation, expert review or pilot evidence.
- **Pessimistic locks:** hold up reviewers and fail badly when someone forgets to release.

## Notes

Schemas live in `packages/schemas/src/skill.ts` and `enums.ts`; unsafe-publication attempts are covered by
security tests (`docs/THREAT_MODEL.md`, AI-6).
