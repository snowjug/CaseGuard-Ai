import type { TimelineAnalysis } from '../agents/outputs';
import { safeId } from './citations';
import { precedes } from './temporal';
import type { OutputIssue, ValidationContext } from './types';
import type { TypedOutput } from './walk';

const MS_PER_MINUTE = 60_000;
const MAX_ISSUES = 10;

function checkDelays(delays: TimelineAnalysis['delays'], vctx: ValidationContext): OutputIssue[] {
  const { index, context } = vctx.built;
  const gapOf = new Map(context.events.map((e) => [e.id, e.gapMinutes]));
  const issues: OutputIssue[] = [];
  delays.forEach((delay, i) => {
    const from = index.events.get(delay.fromEventId);
    const to = index.events.get(delay.toEventId);
    // An event that was not supplied is a citation problem and is reported there.
    if (!from || !to) return;
    const path = `delays[${i}]`;
    const [fromId, toId] = [safeId(delay.fromEventId), safeId(delay.toEventId)];
    if (!precedes(from, to, false)) {
      issues.push({
        kind: 'groundedness',
        code: 'delay_order',
        path,
        message: `A delay must run from an earlier event ("${fromId}") to a later one ("${toId}").`,
      });
      return;
    }
    const recorded = Math.max(
      0,
      Math.round((Date.parse(to.at) - Date.parse(from.at)) / MS_PER_MINUTE),
    );
    if (delay.minutes !== recorded) {
      issues.push({
        kind: 'groundedness',
        code: 'delay_minutes',
        path: `${path}.minutes`,
        message: `The stated wait does not match the event times: the recorded gap between "${fromId}" and "${toId}" is ${recorded} minutes.`,
      });
      return;
    }
    const gapBeforeTo = gapOf.get(delay.toEventId);
    if (gapBeforeTo !== null && gapBeforeTo !== undefined && gapBeforeTo !== recorded) {
      issues.push({
        kind: 'groundedness',
        code: 'delay_not_consecutive',
        path,
        message: `A delay is the wait between two consecutive events, and "${fromId}" is not the event just before "${toId}".`,
      });
    }
  });
  return issues;
}

function checkStepOrder(steps: readonly { order: number }[]): OutputIssue[] {
  const issues: OutputIssue[] = [];
  steps
    .map((step, position) => ({ step, position }))
    .sort((a, b) => a.step.order - b.step.order || a.position - b.position)
    .forEach(({ step, position }, n) => {
      if (step.order !== n + 1) {
        issues.push({
          kind: 'schema',
          code: 'step_order',
          path: `steps[${position}].order`,
          message: 'Step order must be 1..n without gaps or repeats.',
        });
      }
    });
  return issues;
}

/**
 * Numbers and relations that the record can recompute. A model may phrase them but not change
 * them: a delay must run forward in time between two consecutive events and carry exactly the
 * recorded number of minutes; skill steps are numbered 1..n. Messages quote the recomputed values
 * (ours), never the model's.
 */
export function checkFacts(typed: TypedOutput, vctx: ValidationContext): OutputIssue[] {
  switch (typed.agent) {
    case 'timeline_analyzer':
      return checkDelays(typed.output.delays, vctx).slice(0, MAX_ISSUES);
    case 'skilldna_extractor':
      return checkStepOrder(typed.output.steps).slice(0, MAX_ISSUES);
    default:
      return [];
  }
}
