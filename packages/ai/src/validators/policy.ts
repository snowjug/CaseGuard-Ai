import {
  applyOutcome,
  evaluateAction,
  predictOutcomes,
  signalRequirementLinks,
  strategyProfile,
  type RankingState,
} from '@caseguard/domain';
import type { CounterfactualProposal } from '../agents/outputs';
import { safeId } from './citations';
import { findViolations, PEOPLE_RULES, UNSAFE_RECOMMENDATION_RULES } from './unsafe-patterns';
import type { OutputIssue, ValidationContext } from './types';
import { collectCitations, collectTexts, recommendationTexts, type TypedOutput } from './walk';

const MAX_ISSUES = 30;

const policy = (code: string, path: string, message: string): OutputIssue => ({
  kind: 'policy',
  code,
  path,
  message,
});

/** Structural safety: no action reference may be destructive, approval-required or above the risk ceiling. */
function checkActionReferences(output: unknown, vctx: ValidationContext): OutputIssue[] {
  const issues: OutputIssue[] = [];
  const { pack, config } = vctx;
  for (const ref of collectCitations(output)) {
    if (ref.kind !== 'action') continue;
    const action = pack.actions.get(ref.id);
    if (!action) continue;
    const label = `Action "${safeId(ref.id)}"`;
    if (action.destructive) {
      issues.push(
        policy('destructive_action', ref.path, `${label} is destructive and is never recommended.`),
      );
    }
    if (action.requiresApproval) {
      issues.push(
        policy(
          'approval_required_action',
          ref.path,
          `${label} requires approval and is never recommended automatically.`,
        ),
      );
    }
    if (action.operationalRisk >= config.riskCeiling) {
      issues.push(
        policy(
          'risk_at_or_above_ceiling',
          ref.path,
          `${label} is at or above the operational risk ceiling.`,
        ),
      );
    }
  }
  return issues;
}

/**
 * Replays a proposed path against the knowledge-pack safety gates (the same `evaluateAction`
 * verdict the engine uses) while advancing the knowledge state with each step's declared outcome.
 */
function checkCounterfactualPath(
  proposal: CounterfactualProposal,
  state: RankingState,
  vctx: ValidationContext,
): OutputIssue[] {
  const { pack, config, limits } = vctx;
  const issues: OutputIssue[] = [];
  const profile = strategyProfile(proposal.strategy, config);
  const links = signalRequirementLinks(pack);
  let belief = state.belief;
  const observed = new Set(state.observedSignals);
  const satisfied = new Set(state.satisfied);
  const seen = new Set<string>();

  if (proposal.steps.length > limits.maxSteps) {
    issues.push(
      policy(
        'too_many_steps',
        'steps',
        `The path has more than ${limits.maxSteps} steps (analysis-depth limit).`,
      ),
    );
  }
  if (!proposal.labels.simulated || !proposal.labels.estimated) {
    issues.push(
      policy(
        'unlabelled_simulation',
        'labels',
        'Simulated, estimated outcomes must be labelled as such.',
      ),
    );
  }
  const ordered = proposal.steps
    .map((step, position) => ({ step, position }))
    .sort((a, b) => a.step.order - b.step.order || a.position - b.position);
  ordered.forEach(({ step, position }, n) => {
    const path = `steps[${position}]`;
    if (step.order !== n + 1)
      issues.push(policy('bad_order', `${path}.order`, 'Step order must be 1..n without gaps.'));
    const action = pack.actions.get(step.actionKey);
    if (!action) return;
    if (seen.has(action.id))
      issues.push(policy('repeated_action', `${path}.actionKey`, 'The path repeats an action.'));
    seen.add(action.id);
    if (profile.filter && !profile.filter(action)) {
      issues.push(
        policy(
          'strategy_violation',
          `${path}.actionKey`,
          'The action is excluded by the requested strategy.',
        ),
      );
    }
    const verdict = evaluateAction(pack, config, action, {
      belief,
      observedSignals: observed,
      satisfied,
    });
    if (!verdict.allowed) {
      for (const reason of verdict.blockedReasons.slice(0, 2)) {
        issues.push(
          policy(
            'blocked_by_safety_gate',
            `${path}.actionKey`,
            `Not allowed at this point: ${reason}`,
          ),
        );
      }
    }
    let outcomeIndex = -1;
    if (step.expectedOutcomeId !== null) {
      outcomeIndex = action.outcomes.findIndex((o) => o.id === step.expectedOutcomeId);
      if (outcomeIndex < 0) {
        issues.push({
          kind: 'citation',
          code: 'unknown_outcome',
          path: `${path}.expectedOutcomeId`,
          message: 'The named outcome is not defined for this action in the knowledge pack.',
        });
      }
    }
    if (outcomeIndex < 0 && action.outcomes.length > 0) {
      const predicted = predictOutcomes(pack, action, belief);
      outcomeIndex = predicted.reduce(
        (best, o, i) => (o.probability > (predicted[best]?.probability ?? -1) ? i : best),
        0,
      );
    }
    const outcome = outcomeIndex >= 0 ? action.outcomes[outcomeIndex] : undefined;
    if (outcome) {
      belief = applyOutcome(pack, action, outcomeIndex, belief);
      for (const signal of outcome.emitsSignals) {
        observed.add(signal);
        for (const requirement of links.get(signal) ?? []) satisfied.add(requirement);
      }
    }
    for (const requirement of action.produces) satisfied.add(requirement);
  });
  return issues;
}

/**
 * Deterministic safety and responsible-AI policy: structural action gates, the counterfactual
 * validity rules, unsafe recommendation wording, wording about people, and human-approval flags.
 */
export function checkPolicy(typed: TypedOutput, vctx: ValidationContext): OutputIssue[] {
  const issues: OutputIssue[] = [...checkActionReferences(typed.output, vctx)];

  if (typed.agent === 'counterfactual_simulator' && vctx.state) {
    issues.push(...checkCounterfactualPath(typed.output, vctx.state, vctx));
  }
  if (typed.agent === 'skilldna_extractor' && typed.output.requiresHumanApproval !== true) {
    issues.push(
      policy(
        'auto_publish_without_review',
        'requiresHumanApproval',
        'A skill proposal must require human approval and is never published automatically.',
      ),
    );
  }

  for (const { path, text } of recommendationTexts(typed)) {
    for (const hit of findViolations(text, UNSAFE_RECOMMENDATION_RULES, true)) {
      issues.push(policy(hit.code, path, hit.message));
    }
  }
  for (const { path, text } of collectTexts(typed.output)) {
    for (const hit of findViolations(text, PEOPLE_RULES, true)) {
      issues.push(policy(hit.code, path, hit.message));
    }
  }
  return issues.slice(0, MAX_ISSUES);
}
