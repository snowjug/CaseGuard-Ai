import type { WarningCategory } from '@caseguard/schemas';
import { compareIso } from '../util/time';
import { stampOf } from './helpers';
import { closureRules, CLS_CONFLATION, CLS_UNVALIDATED } from './rules-closure';
import {
  communicationRules,
  COM_EXPECTATION,
  COM_WAITING,
  waitingDeadlines,
} from './rules-communication';
import {
  evidenceRules,
  EVD_CONTRADICTED,
  EVD_MIN_EVIDENCE,
  EVD_TEMPLATE,
  EVD_UNSUPPORTED,
} from './rules-evidence';
import { scopingDeadlines, scopingRules, SCO_MISSING } from './rules-scoping';
import {
  troubleshootingRules,
  TRB_HEAVY,
  TRB_KNOWN,
  TRB_REPEAT,
  TRB_RISKY,
} from './rules-troubleshooting';
import type { Checkpoint, WarningCandidate, WarningRule } from './types';

export interface LiveWarningRuleInfo {
  id: string;
  category: WarningCategory;
  /** State warnings clear when their condition stops holding; nudges clear at the next engineer step. */
  kind: 'state' | 'nudge';
  title: string;
  description: string;
}

/** Catalogue of the live quality rules (documentation, UI filters and lifecycle behaviour). */
export const LIVE_WARNING_RULES: readonly LiveWarningRuleInfo[] = [
  {
    id: SCO_MISSING,
    category: 'scoping',
    kind: 'state',
    title: 'Scoping item neither obtained nor requested',
    description:
      'A scoping item the knowledge pack expects at case opening (for example exact failure times) is still missing after the grace period and has not been asked for.',
  },
  {
    id: EVD_MIN_EVIDENCE,
    category: 'evidence',
    kind: 'state',
    title: 'Minimum evidence missing before or at escalation',
    description:
      'Escalation is being considered (tier 1) or has been recorded (tier 2) while the pack’s minimum evidence for escalation is not on record.',
  },
  {
    id: EVD_UNSUPPORTED,
    category: 'evidence',
    kind: 'state',
    title: 'Unsupported root cause or assumption stated as fact',
    description:
      'The latest statement about the cause presents it as established without supporting diagnostic evidence.',
  },
  {
    id: EVD_CONTRADICTED,
    category: 'evidence',
    kind: 'state',
    title: 'Working hypothesis contradicted by evidence on record',
    description:
      'The latest statement keeps a hypothesis that the evidence already on record had turned against.',
  },
  {
    id: EVD_TEMPLATE,
    category: 'evidence',
    kind: 'nudge',
    title: 'Checklist wording used in place of evidence',
    description: 'A statement says a checklist was completed without citing what was observed.',
  },
  {
    id: TRB_REPEAT,
    category: 'troubleshooting',
    kind: 'nudge',
    title: 'Repeated diagnostic',
    description: 'A step repeats earlier work whose result is already on record.',
  },
  {
    id: TRB_KNOWN,
    category: 'troubleshooting',
    kind: 'nudge',
    title: 'Outcome already known',
    description: 'A check was run although the evidence on record already answers it.',
  },
  {
    id: TRB_RISKY,
    category: 'troubleshooting',
    kind: 'nudge',
    title: 'Risky or disruptive step without justification',
    description:
      'A risky or disruptive change went ahead before the hypothesis it targets was justified by evidence.',
  },
  {
    id: TRB_HEAVY,
    category: 'troubleshooting',
    kind: 'nudge',
    title: 'Heavy customer request when a lighter one exists',
    description: 'The customer was asked for substantial effort when a lighter step was available.',
  },
  {
    id: COM_WAITING,
    category: 'communication',
    kind: 'state',
    title: 'Customer waiting without an update',
    description:
      'A customer message that expects an answer has had no engineer-facing reply for the configured number of hours.',
  },
  {
    id: COM_EXPECTATION,
    category: 'communication',
    kind: 'nudge',
    title: 'Heavy request without an expectation set',
    description:
      'A message asks the customer for substantial effort without saying what happens next or when they will hear back.',
  },
  {
    id: CLS_UNVALIDATED,
    category: 'closure',
    kind: 'state',
    title: 'Closure without validation or customer confirmation',
    description:
      'The case was marked resolved without a before/after validation or the customer’s confirmation.',
  },
  {
    id: CLS_CONFLATION,
    category: 'closure',
    kind: 'state',
    title: 'Workaround and permanent fix conflated',
    description: 'A workaround is described but not separated from the permanent fix.',
  },
];

const RULES: readonly WarningRule[] = [
  ...scopingRules,
  ...evidenceRules,
  ...troubleshootingRules,
  ...communicationRules,
  ...closureRules,
];

const KIND_BY_RULE = new Map(LIVE_WARNING_RULES.map((r) => [r.id, r.kind]));

export const ruleKindOf = (ruleId: string): 'state' | 'nudge' =>
  KIND_BY_RULE.get(ruleId) ?? 'state';

/** Runs every rule at one checkpoint; duplicate dedupe keys keep the first candidate. */
export function evaluateRules(cp: Checkpoint): WarningCandidate[] {
  const seen = new Set<string>();
  const out: WarningCandidate[] = [];
  for (const rule of RULES) {
    for (const found of rule(cp)) {
      if (seen.has(found.dedupeKey)) continue;
      seen.add(found.dedupeKey);
      out.push(found);
    }
  }
  return out.sort(
    (a, b) =>
      compareIso(a.raisedAt, b.raisedAt) ||
      (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0),
  );
}

/** Future instants (after `cp.now`) at which a time-based condition may start to hold. */
export function ruleDeadlines(cp: Checkpoint): string[] {
  return [...new Set([...waitingDeadlines(cp), ...scopingDeadlines(cp)])].sort(compareIso);
}

/** Plain-language reason a state warning cleared, from the information known at the checkpoint. */
export function resolutionReason(ruleId: string, cp: Checkpoint): string {
  const when = stampOf(cp.now);
  switch (ruleId) {
    case EVD_MIN_EVIDENCE:
      return `The minimum evidence for escalation is now on record (as of ${when}).`;
    case EVD_UNSUPPORTED:
      return `A later statement no longer presents the cause as established fact (as of ${when}).`;
    case EVD_CONTRADICTED:
      return `The working hypothesis was revised and no longer conflicts with the evidence on record (as of ${when}).`;
    case COM_WAITING:
      return `The customer was answered (as of ${when}).`;
    case SCO_MISSING:
      return `The scoping item was obtained or requested (as of ${when}).`;
    case CLS_UNVALIDATED:
      return `The missing validation and confirmation are now on record (as of ${when}).`;
    case CLS_CONFLATION:
      return `The workaround and the permanent fix are now described separately (as of ${when}).`;
    default:
      return `The condition no longer holds (as of ${when}).`;
  }
}
