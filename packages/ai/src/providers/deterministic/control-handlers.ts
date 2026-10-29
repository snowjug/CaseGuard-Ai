import type { SafetyVerdict, TokenGovernorDecision } from '../../agents/outputs';
import { SAFETY_RULES_VERSION } from '../../agents/notices';
import type { GovernorTaskInput, SafetyTaskInput } from '../../agents/tasks';
import type { TokenGovernor } from '../../governor/token-governor';
import { validateAgentOutput } from '../../validators';
import { clip } from './shared';

/** Route, limits and budget verdict for a prospective model call; pure code. */
export function runTokenGovernor(
  input: GovernorTaskInput,
  governor: TokenGovernor,
): TokenGovernorDecision {
  const limits = governor.limitsFor(input.targetAgent);
  const route = governor.route(input.targetAgent, input.providerKind);
  const verdict = governor.checkBudget({
    tenantId: input.tenantId,
    caseId: input.caseId,
    agent: input.targetAgent,
    estimatedInputTokens: input.estimatedInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
  });
  return {
    allowed: verdict.allowed,
    reason: clip(verdict.allowed ? `Within budget. ${route.reason}` : verdict.reason, 300),
    tier: route.tier,
    model: route.model,
    limits,
    estimatedInputTokens: Math.max(0, Math.round(input.estimatedInputTokens)),
  };
}

/** Runs every output validator against a candidate and reports the verdict; pure code. */
export function runSafetyValidator(input: SafetyTaskInput): SafetyVerdict {
  const report = validateAgentOutput(input.candidateAgent, input.candidateOutput, input.validation);
  return {
    verdict: report.issues.length === 0 ? 'pass' : 'block',
    checkedAgent: input.candidateAgent,
    rulesVersion: SAFETY_RULES_VERSION,
    issues: report.issues.slice(0, 50).map((i) => ({
      kind: i.kind,
      code: clip(i.code, 60),
      path: i.path.slice(0, 200),
      message: clip(i.message, 300),
    })),
  };
}
