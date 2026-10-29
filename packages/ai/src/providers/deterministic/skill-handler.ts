import type { SkillProposal } from '../../agents/outputs';
import type { SkillTaskInput } from '../../agents/tasks';
import { scopeAnalysis } from '../../context/scope';
import { AiTaskError } from '../../errors';
import { clip, oneLine, percent, unique, uncertainty } from './shared';

/**
 * Drafts a skill from an accepted counterfactual scenario: steps are the scenario's own actions
 * (all pack-defined and safe), triggers are the signals that justified them. The draft always
 * requires human approval; lifecycle and publication are decided elsewhere.
 */
export function runSkillExtractor(input: SkillTaskInput): SkillProposal {
  const scoped = scopeAnalysis(input);
  const { pack, fork, scenario } = input;
  const evidenceById = new Map(scoped.evidence.map((e) => [e.id, e]));
  const steps = scenario.steps.slice(0, 10);
  const usedEvidence = unique(steps.flatMap((s) => s.evidenceUsedIds)).filter((id) =>
    evidenceById.has(id),
  );

  const triggers = unique(
    usedEvidence.flatMap((id) => {
      const signalId = evidenceById.get(id)?.signalId;
      return signalId && pack.signals.has(signalId) ? [signalId] : [];
    }),
  ).slice(0, 10);
  const fallbackTriggers = unique(
    scoped.evidence.flatMap((e) => (pack.signals.has(e.signalId) ? [e.signalId] : [])),
  ).slice(0, 3);
  const triggerIds = triggers.length > 0 ? triggers : fallbackTriggers;
  if (triggerIds.length === 0) {
    throw new AiTaskError(
      'invalid_input',
      'No knowledge-pack signal is available to anchor the skill triggers.',
    );
  }
  const requirements = unique(
    steps.flatMap((s) => pack.actions.get(s.actionKey)?.requires ?? []),
  ).filter((r) => pack.requirements.has(r));

  const leader = steps[steps.length - 1]?.posteriorAfter[0];
  const firstLabel = steps[0]?.label ?? scenario.label;
  const policies = pack.pack.policies;
  const escalationLabels = policies.minimumEvidenceForEscalation
    .map((r) => pack.requirements.get(r)?.label)
    .filter((label): label is string => label !== undefined);

  return {
    name: clip(`${leader ? `${leader.name}: ` : ''}${firstLabel}`, 160),
    description: clip(
      `Draft skill distilled from a simulated “${scenario.label}” path at a ${fork.category.replace(/_/g, ' ')} decision point. Steps: ${steps.map((s) => s.label).join(' then ')}.`,
      800,
    ),
    triggerSignalIds: triggerIds,
    minimumEvidenceRequirementIds: requirements.slice(0, 10),
    steps: steps.map((s) => ({
      order: s.index + 1,
      title: clip(s.label, 160),
      instruction: clip(pack.actions.get(s.actionKey)?.description ?? s.label, 500),
      actionKey: s.actionKey,
      eventIds: [fork.eventId],
      evidenceIds: s.evidenceUsedIds.filter((id) => evidenceById.has(id)).slice(0, 8),
    })),
    stopConditions: [
      clip(
        `Stop testing once the leading hypothesis reaches ${percent(policies.diagnosisThreshold)} and its confirmation requirements are met.`,
        300,
      ),
    ],
    successConditions: [
      'The leading hypothesis is confirmed by diagnostic evidence and the fix is validated.',
    ],
    escalationConditions: [
      clip(
        escalationLabels.length > 0
          ? `Escalate after collecting: ${escalationLabels.join('; ')}.`
          : 'Escalate after the minimum evidence for escalation has been collected.',
        300,
      ),
    ],
    safetyConstraints: [
      'Use read-only or reversible diagnostic steps until a hypothesis is confirmed.',
      'Any destructive, disruptive or approval-required action needs a separate, explicit human decision.',
    ],
    sourceEventIds: unique([
      fork.eventId,
      ...usedEvidence.flatMap((id) => {
        const eventId = evidenceById.get(id)?.eventId;
        return eventId ? [eventId] : [];
      }),
    ]).slice(0, 20),
    requiresHumanApproval: true,
    uncertainty: uncertainty(
      'medium',
      oneLine(
        `Derived from one simulated path (${scenario.comparisonConfidence.level} comparison confidence); validate on further cases before relying on it.`,
        300,
      ),
    ),
  };
}
