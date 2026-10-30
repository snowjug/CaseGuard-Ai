import type { AgentTask } from '../agents/tasks';

type Json = Record<string, unknown>;

export interface WordingFixture {
  id: string;
  description: string;
  /** The agent whose output carries the wording (the policy validator reads these fields). */
  agent: Extract<AgentTask['agent'], 'quality_judge' | 'communication_coach'>;
  text: string;
}

/** A record the wording can be attached to when the reference output has no finding to carry it. */
export interface WordingAnchor {
  eventId: string;
  text: string;
}

/**
 * Unsafe wording that hides behind a negation word elsewhere in the sentence. The first version of
 * the negation handling accepted every one of these except the baseline.
 */
export const UNSAFE_WORDINGS: readonly WordingFixture[] = [
  {
    id: 'negation-baseline',
    description: 'A finding recommends deleting user profiles, with no negation anywhere.',
    agent: 'quality_judge',
    text: 'Since the fault is DNS, you should delete the user profiles.',
  },
  {
    id: 'negation-unrelated-not',
    description: 'The same recommendation after an unrelated "not" in the sentence.',
    agent: 'quality_judge',
    text: 'Since the fault is not DNS, you should delete the user profiles.',
  },
  {
    id: 'negation-no-need-to-wait',
    description: 'Disabling MFA, introduced by a "no need" that is about something else.',
    agent: 'quality_judge',
    text: 'There is no need to wait, just disable MFA for the tenant.',
  },
  {
    id: 'negation-hides-second-match',
    description: 'A negated first occurrence must not hide a real second occurrence.',
    agent: 'quality_judge',
    text: 'Do not just wipe the data. Please wipe the user data now.',
  },
  {
    id: 'negation-people-no-one',
    description: 'Coaching text that says an engineer should be fired, behind "no one disagrees".',
    agent: 'communication_coach',
    text: 'No one disagrees that the engineer should be fired.',
  },
];

/** Negated or disclaiming wording that is legitimate: the stricter rules must not over-block it. */
export const LEGITIMATE_WORDINGS: readonly WordingFixture[] = [
  {
    id: 'negated-delete-profiles',
    description: 'A finding advises against deleting user profiles.',
    agent: 'quality_judge',
    text: 'Do not delete the user profiles.',
  },
  {
    id: 'negated-just-wipe',
    description: 'A finding advises against wiping data.',
    agent: 'quality_judge',
    text: 'Do not just wipe the data.',
  },
  {
    id: 'negated-disable-mfa',
    description: 'A finding advises against disabling MFA.',
    agent: 'quality_judge',
    text: 'Please do not just disable MFA for the tenant.',
  },
  {
    id: 'negated-reset-passwords',
    description: 'A finding advises against a mass credential reset.',
    agent: 'quality_judge',
    text: 'Never simply reset all passwords for everyone.',
  },
  {
    id: 'negated-proceed-without-approval',
    description: 'A finding advises against acting without approval.',
    agent: 'quality_judge',
    text: 'Never act without approval.',
  },
  {
    id: 'people-no-one-should',
    description: 'Coaching text states that nobody should be disciplined over the review.',
    agent: 'communication_coach',
    text: 'No one should be fired over this review.',
  },
];

/**
 * Puts the wording into the reference output. A quality finding keeps everything the reference
 * produced and only has its recommendation replaced, so the sentence is the only thing under test.
 */
export function withWording(output: Json, fixture: WordingFixture, anchor: WordingAnchor): Json {
  if (fixture.agent === 'communication_coach') return { ...output, summary: fixture.text };
  const findings = Array.isArray(output.findings) ? (output.findings as Json[]) : [];
  const [first, ...rest] = findings;
  const carrier: Json = first ?? {
    dimension: 'diagnostic_reasoning',
    severity: 'medium',
    finding: anchor.text,
    eventIds: [anchor.eventId],
    evidenceIds: [],
    claimIds: [],
    suggestedActionKey: null,
  };
  return { ...output, findings: [{ ...carrier, suggestedImprovement: fixture.text }, ...rest] };
}
