import { rankActions, strategyProfile } from '@caseguard/domain';
import type { AgentTask } from '../agents/tasks';
import type { ReviewConclusion } from '../reasoning/types';
import type { Redactor } from '../types';
import { clip, collapseWhitespace } from '../util/text';
import { hypothesisStandingAsOf, likelihoodLevel } from './derive';
import type { ScopedAnalysis } from './scope';
import type { EventStamp } from './types';

export interface FocusDeps {
  maxAnalysisDepth: number;
  /** Applied to every text of a conclusion under review before it is shown (they quote and paraphrase the record). */
  redact: Redactor;
}

/** The most conclusions the critic is given to review. The rest are not shown to it; they are still findings. */
export const MAX_CONCLUSIONS_UNDER_REVIEW = 30;

const conclusionFocus = (c: ReviewConclusion, redact: Redactor) => {
  const text = (value: string, max: number): string => clip(collapseWhitespace(redact(value)), max);
  return {
    id: c.id,
    source: c.source,
    kind: c.kind,
    text: text(c.text, 300),
    reasoning: c.reasoning === null ? null : text(c.reasoning, 300),
    confidenceBasis: c.confidenceBasis,
    confidence: c.confidence,
    eventIds: c.eventIds.slice(0, 8),
    evidence: c.evidence
      .slice(0, 3)
      .map((e) => ({ eventId: e.eventId, excerpt: text(e.excerpt, 200) })),
  };
};

export interface FocusResult {
  focus: Record<string, unknown>;
  /** Valid citation targets that are not part of the visible view (the fork's own decision event). */
  anchors: Map<string, EventStamp>;
  /** Action ids the model may reference when the knowledge catalog is not included. */
  actionIds: Set<string>;
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function leadingHypothesis(
  task: Extract<AgentTask, { input: { analysis: unknown } }>,
  scoped: ScopedAnalysis,
) {
  const { pack, analysis } = task.input;
  const belief = scoped.state.belief;
  const top = Object.entries(belief).sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const record = analysis.hypotheses.find((h) => h.key === top[0]);
  const standing = record ? hypothesisStandingAsOf(record, scoped.eventIds) : null;
  return {
    key: top[0],
    name: pack.hypotheses.get(top[0])?.name ?? top[0],
    status: standing?.status ?? 'active',
    likelihood: likelihoodLevel(top[1]),
  };
}

function resolutionFocus(task: Extract<AgentTask, { input: { view: unknown } }>) {
  const resolution = task.input.view.resolution;
  if (!resolution) return null;
  return {
    resolvedAt: resolution.resolvedAt,
    summary: clip(resolution.summary, 500),
    rootCause: clip(resolution.rootCause, 400),
    workaround: resolution.workaround ? clip(resolution.workaround, 300) : null,
    permanentFix: resolution.permanentFix ? clip(resolution.permanentFix, 300) : null,
    validationOutcome: resolution.validation?.outcome ?? null,
  };
}

const forkSummaries = (scoped: ScopedAnalysis) =>
  scoped.forks.map((f) => ({
    eventId: f.eventId,
    category: f.category,
    severity: f.severity,
    title: clip(f.title, 160),
    earliestMeaningful: f.isEarliestMeaningful,
  }));

const openRequirements = (scoped: ScopedAnalysis) =>
  scoped.missing
    .filter((m) => m.openAtBoundary && m.criticality !== 'helpful')
    .map((m) => ({
      requirementId: m.requirementId,
      label: m.label,
      criticality: m.criticality,
      askText: clip(m.askText, 200),
    }));

/** Agent-specific, JSON-serialisable material that sits next to the generic events/evidence/claims. */
export function buildFocus(task: AgentTask, scoped: ScopedAnalysis, deps: FocusDeps): FocusResult {
  const anchors = new Map<string, EventStamp>();
  const actionIds = new Set<string>();
  switch (task.agent) {
    case 'decision_fork_detector':
      return {
        focus: {
          engineerActions: scoped.actions.map((a) => ({
            eventId: a.eventId,
            actionKey: a.actionKey,
            label: clip(a.label, 160),
            kind: a.kind,
            customerEffort: a.customerEffort,
            destructive: a.destructive,
          })),
        },
        anchors,
        actionIds,
      };
    case 'counterfactual_simulator': {
      const { fork, strategy, pack, config, events } = task.input;
      const profile = strategyProfile(strategy, config);
      const ranked = rankActions(pack, config, scoped.state.rankingState, {
        weights: profile.weights,
        ...(profile.filter ? { filter: profile.filter } : {}),
      });
      const forkEvent = events.find((e) => e.id === fork.eventId);
      if (forkEvent)
        anchors.set(forkEvent.id, { at: forkEvent.timestamp, sequence: forkEvent.sequence });
      const allowed = ranked.candidates.slice(0, 12).map((e) => ({
        id: e.action.id,
        label: e.action.label,
        kind: e.action.kind,
        executor: e.action.executor,
        customerEffort: e.action.customerEffort,
        operationalRisk: e.action.operationalRisk,
        expectedInformationGainBits: round(e.eigBits, 2),
        outcomes: e.action.outcomes.map((o) => ({ id: o.id, label: o.label })),
      }));
      const blocked = ranked.blocked.slice(0, 8).map((e) => ({
        id: e.action.id,
        reasons: e.blockedReasons.slice(0, 2).map((r) => clip(r, 160)),
      }));
      for (const a of [...allowed, ...blocked]) actionIds.add(a.id);
      return {
        focus: {
          forkEventId: fork.eventId,
          decisionAt: fork.timestamp,
          forkCategory: fork.category,
          strategy,
          actualAction: { label: clip(fork.actual.label, 200), kind: fork.actual.kind },
          maxSteps: Math.min(deps.maxAnalysisDepth, pack.pack.policies.maxCounterfactualSteps),
          allowedActions: allowed,
          blockedActions: blocked,
        },
        anchors,
        actionIds,
      };
    }
    case 'quality_judge':
      return {
        focus: {
          forks: forkSummaries(scoped),
          openRequirements: openRequirements(scoped),
          leadingHypothesis: leadingHypothesis(task, scoped),
          resolution: resolutionFocus(task),
        },
        anchors,
        actionIds,
      };
    case 'communication_coach':
      return {
        focus: {
          forks: forkSummaries(scoped),
          openRequirements: openRequirements(scoped),
          wellChosenActions: scoped.actions
            .filter((a) => (a.relativeValueAtDecision ?? 0) >= 0.8 && !a.lowValue && !a.isRepeat)
            .map((a) => ({ eventId: a.eventId, label: clip(a.label, 160) })),
          resolution: resolutionFocus(task),
        },
        anchors,
        actionIds,
      };
    case 'skilldna_extractor': {
      const { fork, scenario } = task.input;
      return {
        focus: {
          fork: {
            eventId: fork.eventId,
            category: fork.category,
            title: clip(fork.title, 160),
          },
          scenario: {
            strategy: scenario.strategy,
            label: scenario.label,
            summary: clip(scenario.summary, 400),
            assumptions: scenario.assumptions.map((a) => clip(a, 200)),
            steps: scenario.steps.map((s) => ({
              order: s.index + 1,
              actionKey: s.actionKey,
              label: s.label,
              rationale: clip(s.rationale, 300),
              evidenceUsedIds: s.evidenceUsedIds,
              customerEffort: s.customerEffort,
              safetyNotes: s.safetyNotes.map((n) => clip(n, 160)),
            })),
          },
          resolution: resolutionFocus(task),
        },
        anchors,
        actionIds,
      };
    }
    case 'token_governor':
    case 'safety_policy_validator':
    case 'timeline_analyzer':
    case 'evidence_classifier':
    case 'hypothesis_generator':
    case 'case_reasoner':
      return { focus: {}, anchors, actionIds };
    case 'case_critic':
      return {
        focus: {
          conclusions: task.input.conclusions
            .slice(0, MAX_CONCLUSIONS_UNDER_REVIEW)
            .map((c) => conclusionFocus(c, deps.redact)),
        },
        anchors,
        actionIds,
      };
  }
}
