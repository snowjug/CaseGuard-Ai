import { DEFAULT_MODEL_CONFIG, type ModelConfig } from '@caseguard/schemas';
import type { EvidenceClassification, ForkProposals, SkillProposal } from '../agents/outputs';
import type { AgentTask } from '../agents/tasks';
import { describeError } from '../errors';
import { TokenGovernor } from '../governor/token-governor';
import { prepareTask, type PrepareDeps } from '../orchestrator/prepare';
import { createPromptRegistry } from '../prompts/registry';
import { runDeterministicTask } from '../providers/deterministic/provider';
import {
  systemClock,
  type Clock,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '../types';
import { toIso } from '../util/ids';
import { validateAgentOutput } from '../validators';
import { defaultInjectionScanner } from '../validators/injection';
import { runAdversarialSuite, runControlSuite } from './adversarial';
import {
  classifierAgreement,
  computeMetrics,
  evaluateGates,
  forkAgreement,
  skillCompleteness,
  summarizeByAgent,
} from './metrics';
import { planSamples, type PlanOptions, type PlannedSample } from './plan';
import {
  DETERMINISTIC_THRESHOLDS,
  MODEL_THRESHOLDS,
  type AdversarialResult,
  type ControlResult,
  type EvalCase,
  type EvalReport,
  type EvalSample,
  type EvalThresholds,
} from './types';

export interface EvalOptions {
  provider: ModelProvider;
  cases: readonly EvalCase[];
  config?: ModelConfig;
  thresholds?: EvalThresholds;
  plan?: PlanOptions;
  clock?: Clock;
  /** Stop after this many provider calls (keeps a paid-model evaluation bounded). */
  maxSamples?: number;
  signal?: AbortSignal;
  /** Model/deployment name passed to a remote provider. */
  model?: string;
}

const SAFETY_STEP_CODES: ReadonlySet<string> = new Set([
  'blocked_by_safety_gate',
  'destructive_action',
  'approval_required_action',
  'risk_at_or_above_ceiling',
  'strategy_violation',
  'repeated_action',
]);

function referenceFor(agent: AgentTask['agent'], task: AgentTask): unknown {
  if (agent !== 'evidence_classifier' && agent !== 'decision_fork_detector') return null;
  return runDeterministicTask(task);
}

async function evaluateSample(
  provider: ModelProvider,
  sample: PlannedSample,
  index: number,
  deps: PrepareDeps,
  config: ModelConfig,
  model: string,
  signal: AbortSignal | undefined,
): Promise<EvalSample> {
  const { task } = sample;
  const prepared = prepareTask(task, `eval-${index}`, model, deps, { applyBudget: false });
  const request: ModelRequest = {
    requestId: `eval-${index}`,
    tenantId: task.input.tenantId,
    agent: task.agent,
    messages: prepared.messages,
    structuredOutput: {
      name: prepared.prompt.outputSchemaId,
      schema: prepared.prompt.jsonSchema,
      strict: true,
    },
    maxOutputTokens: prepared.limits.maxOutputTokens,
    temperature: config.temperature,
    timeoutMs: prepared.limits.timeoutMs,
    maxRetries: prepared.limits.maxRetries,
    model: provider.kind === 'deterministic' ? null : model,
    signal,
    task,
  };
  const base = { caseId: sample.caseId, agent: task.agent, label: sample.label };
  let response: ModelResponse;
  try {
    response = await provider.complete(request);
  } catch (error) {
    return {
      ...base,
      providerError: describeError(error),
      schemaValid: false,
      citationsValid: false,
      policyValid: true,
      temporalValid: true,
      unsafeRecommendation: false,
      claims: 0,
      supportedClaims: 0,
      citations: 0,
      validCitations: 0,
      issueKinds: [],
      issueCodes: [],
      agreement: null,
      completeness: null,
      stepSafety: null,
      forkRecall: null,
      forkPrecision: null,
      usage: null,
      latencyMs: 0,
    };
  }
  const report = validateAgentOutput(task.agent, response.output, prepared.vctx);
  const reference = referenceFor(task.agent, task);
  let agreement = null;
  let forkRecall = null;
  let forkPrecision = null;
  if (task.agent === 'evidence_classifier') {
    agreement = classifierAgreement(
      report.output as EvidenceClassification | null,
      reference as EvidenceClassification,
    );
  }
  if (task.agent === 'decision_fork_detector') {
    const forks = forkAgreement(report.output as ForkProposals | null, reference as ForkProposals);
    agreement = forks.category;
    forkRecall = forks.recall;
    forkPrecision = forks.precision;
  }
  const steps =
    task.agent === 'counterfactual_simulator' && report.output
      ? (report.output as { steps: unknown[] }).steps.length
      : 0;
  const unsafeSteps = report.issues.filter(
    (i) => i.kind === 'policy' && SAFETY_STEP_CODES.has(i.code),
  ).length;
  return {
    ...base,
    providerError: null,
    schemaValid: report.outcome.schemaValid,
    citationsValid: report.outcome.citationsValid,
    policyValid: report.outcome.policyValid,
    temporalValid: report.outcome.temporalValid,
    unsafeRecommendation: report.issues.some((i) => i.kind === 'policy'),
    claims: report.stats.claims,
    supportedClaims: report.stats.supportedClaims,
    citations: report.stats.citations,
    validCitations: report.stats.validCitations,
    issueKinds: report.kinds,
    issueCodes: report.issues.map((i) => i.code),
    agreement,
    completeness:
      task.agent === 'skilldna_extractor'
        ? report.output
          ? skillCompleteness(report.output as SkillProposal)
          : 0
        : null,
    stepSafety:
      task.agent === 'counterfactual_simulator' && report.outcome.schemaValid
        ? { matched: Math.max(0, steps - unsafeSteps), total: steps }
        : null,
    forkRecall,
    forkPrecision,
    usage: response.usage,
    latencyMs: response.latencyMs,
  };
}

/**
 * Golden-case evaluation of any provider against the synthetic cases. The provider is called
 * directly (no fallback) so measured rates describe the provider itself; every output goes through
 * the same validators production uses.
 */
export async function runEvaluation(options: EvalOptions): Promise<EvalReport> {
  const config = options.config ?? DEFAULT_MODEL_CONFIG;
  const clock = options.clock ?? systemClock;
  const { provider } = options;
  const descriptor = provider.describe();
  const thresholds =
    options.thresholds ?? (provider.simulated ? DETERMINISTIC_THRESHOLDS : MODEL_THRESHOLDS);
  const deps: PrepareDeps = {
    registry: createPromptRegistry(),
    governor: new TokenGovernor({ config, clock }),
    redact: (text) => text,
    scanInjection: defaultInjectionScanner,
  };
  const model = options.model ?? provider.defaultModel;

  const planned = options.cases.flatMap((c) => planSamples(c, options.plan));
  const limited = options.maxSamples === undefined ? planned : planned.slice(0, options.maxSamples);
  const samples: EvalSample[] = [];
  for (const [index, sample] of limited.entries()) {
    samples.push(
      await evaluateSample(provider, sample, index, deps, config, model, options.signal),
    );
  }
  const adversarial: AdversarialResult[] = options.cases.flatMap((c) =>
    runAdversarialSuite(c, deps),
  );
  const controls: ControlResult[] = options.cases.flatMap((c) => runControlSuite(c, deps));
  const metrics = computeMetrics(samples, adversarial, controls);
  const gates = evaluateGates(metrics, thresholds);
  const notes = [
    descriptor.validationNote,
    'Agreement is measured against the deterministic knowledge-pack reference on two synthetic cases; it is not a claim about real-world accuracy.',
  ];
  if (provider.simulated) {
    notes.push(
      'The provider under test is the deterministic reference itself, so these gates verify the contracts and validators, not model quality.',
    );
  }
  if (limited.length < planned.length)
    notes.push(`Evaluation was limited to ${limited.length} of ${planned.length} planned samples.`);
  return {
    generatedAt: toIso(clock.nowMs()),
    provider: {
      kind: descriptor.kind,
      model: descriptor.model,
      simulated: descriptor.simulated,
      validationNote: descriptor.validationNote,
    },
    cases: options.cases.map((c) => ({ id: c.id, label: c.label, events: c.events.length })),
    thresholds,
    metrics,
    byAgent: summarizeByAgent(samples),
    samples,
    adversarial,
    controls,
    gates,
    passed: gates.every((g) => g.passed),
    notes,
  };
}
