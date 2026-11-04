import type { EventStamp } from '../context/types';
import type { InjectionScanner } from '../types';
import type { LeakGuard, ValidationContext } from '../validators/types';
import { isRecord } from './text';
import type { ProposalAgent, StoredEvent } from './types';

/** One event as the rules see it: what the model was shown and what is stored. */
export interface RuleEvent {
  id: string;
  at: string;
  sequence: number;
  /** The title as the model was shown it: redacted, whitespace collapsed, clipped. Null when none was shown. */
  shownTitle: string | null;
  /** The body as the model was shown it. Null when only the header was shown or the body was a duplicate. */
  shownText: string | null;
  storedTitle: string | null;
  storedBody: string;
}

export interface Vocabulary {
  signals: ReadonlySet<string>;
  actions: ReadonlySet<string>;
  requirements: ReadonlySet<string>;
  hypotheses: ReadonlySet<string>;
  /** Skill ids the model may name. None are given to the reasoner, so a skill id is always unknown. */
  skills: ReadonlySet<string>;
}

/** What the safety policy needs to know about the actions of the pack. */
export interface PolicyFacts {
  riskCeiling: number;
  actions: ReadonlyMap<
    string,
    { destructive: boolean; requiresApproval: boolean; operationalRisk: number }
  >;
}

/** Everything the grounding rules need. Plain data, so a rule can be tested without the engine. */
export interface RuleContext {
  agent: ProposalAgent;
  /** The events the model was shown, by id. An id that is not here is not an event the model could cite. */
  events: ReadonlyMap<string, RuleEvent>;
  /** Events that exist but lie after the temporal boundary (from the hindsight the leak guard holds). */
  futureEventIds: ReadonlySet<string>;
  leakGuard: LeakGuard | null;
  vocabulary: Vocabulary;
  policy: PolicyFacts;
  /** The ids of the conclusions under review (the critic may target only these). */
  conclusionIds: ReadonlySet<string>;
  scanInjection: InjectionScanner;
  /** What the existing output-side injection checks need. */
  injection: {
    allText: string;
    promptGuard: { templateShingles: ReadonlySet<string>; nonce: string | null };
  };
  limits: { maxOutputChars: number };
}

const EMPTY: ReadonlySet<string> = new Set<string>();

const conclusionIdsOf = (focus: Record<string, unknown>): ReadonlySet<string> => {
  const list = focus.conclusions;
  if (!Array.isArray(list)) return EMPTY;
  return new Set(list.flatMap((c) => (isRecord(c) && typeof c.id === 'string' ? [c.id] : [])));
};

/** The rule context of a validated task: the events as shown and as stored, the allow-lists and the guards. */
export function buildRuleContext(
  agent: ProposalAgent,
  vctx: ValidationContext,
  stored: ReadonlyMap<string, StoredEvent>,
): RuleContext {
  const { built } = vctx;
  const stamps: ReadonlyMap<string, EventStamp> = built.index.events;
  const events = new Map<string, RuleEvent>();
  for (const shown of built.context.events) {
    const stamp = stamps.get(shown.id);
    const original = stored.get(shown.id);
    if (!stamp || !original) continue;
    events.set(shown.id, {
      id: shown.id,
      at: stamp.at,
      sequence: stamp.sequence,
      shownTitle: shown.title,
      shownText: shown.text,
      storedTitle: original.title,
      storedBody: original.body,
    });
  }
  return {
    agent,
    events,
    futureEventIds: vctx.leakGuard?.futureEventIds ?? EMPTY,
    leakGuard: vctx.leakGuard,
    vocabulary: {
      signals: built.index.signals,
      actions: built.index.actions,
      requirements: built.index.requirements,
      hypotheses: built.index.hypotheses,
      skills: EMPTY,
    },
    policy: {
      riskCeiling: vctx.config.riskCeiling,
      actions: new Map(
        [...vctx.pack.actions.values()].map((a) => [
          a.id,
          {
            destructive: a.destructive,
            requiresApproval: a.requiresApproval,
            operationalRisk: a.operationalRisk,
          },
        ]),
      ),
    },
    conclusionIds: conclusionIdsOf(built.context.focus),
    scanInjection: vctx.scanInjection,
    injection: { allText: built.allText, promptGuard: vctx.promptGuard },
    limits: { maxOutputChars: vctx.limits.maxOutputChars },
  };
}
