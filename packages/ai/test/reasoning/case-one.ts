import { DEFAULT_MODEL_CONFIG, type AgentBudget, type ModelConfig } from '@caseguard/schemas';
import {
  AiOrchestrator,
  createScriptedTestProvider,
  prepareTask,
  validateProposalOutput,
  type AgentTask,
  type AiOrchestratorOptions,
  type ReviewDeps,
  type ReviewInput,
  type ReviewConclusion,
  type Script,
  type ScriptedProviderOptions,
  type ScriptedTestProvider,
  type ValidationContext,
} from '../../src';
import { CASE_ONE, eventBySuffix, prepareCase } from '../helpers';
import { FakeClock, capturingLogger, capturingMetrics } from '../fakes';
import { baseOf, viewUpTo } from '../tasks';
import { buildConclusions } from '../../src/reasoning/conclusions';
import { deterministicFactsOf } from '../../src/reasoning/facts';
import type { KeptProposal } from '../../src/reasoning/types';

/**
 * Case One (synthetic) reviewed at the moment the engineer dismisses the network-log summary (event e15). Everything
 * the pipeline does is real: the context is built from the case, the rules read the events as stored. Only the model
 * is a script. The quotations are verbatim parts of the synthetic events.
 */
export const one = prepareCase(CASE_ONE);
export const BOUNDARY = 'e15';
export const view = viewUpTo(one, BOUNDARY);

/** The id of an event of Case One, by its suffix (`e07`). */
export const eid = (suffix: string): string => eventBySuffix(one, suffix).id;

const cite = (suffix: string, excerpt: string) => ({ eventId: eid(suffix), excerpt });

const tail = (
  evidence: { eventId: string; excerpt: string }[],
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  evidence,
  reasoning: 'The cited text says this in the record.',
  confidenceBasis: 'stated_in_record',
  confidence: 'medium',
  uncertainty: { level: 'low', note: 'The record states it directly.' },
  contradictions: [],
  ...over,
});

export const HAR_QUOTE =
  'several requests to aadcdn.msftauth.net failing with ERR_NAME_NOT_RESOLVED';
export const TRACE_QUOTE =
  'Full HAR and Fiddler captures will take a while because users are in calls';

/** Eight grounded proposals over Case One: one of each type, and two signals. A function: every call gives fresh objects. */
export function validProposals(): Record<string, Record<string, unknown>> {
  return {
    sg1: {
      id: 'sg1',
      type: 'signal',
      statement:
        'The case note reports an MFA-required error in the sign-in logs for the affected users.',
      signalId: 'sig.mfa-ca-events-in-logs',
      eventId: eid('e07'),
      ...tail(
        [
          cite(
            'e07',
            'the sign-in logs show AADSTS50076 (MFA required by Conditional Access) for the affected users',
          ),
        ],
        { confidence: 'high', reasoning: 'The note states the log result in so many words.' },
      ),
    },
    sg2: {
      id: 'sg2',
      type: 'signal',
      statement:
        'The customer reports failed requests to the sign-in host with a name-resolution error.',
      signalId: 'sig.error-name-not-resolved',
      eventId: eid('e14'),
      ...tail([cite('e14', HAR_QUOTE)], { reasoning: 'The network log summary names the error.' }),
    },
    ct1: {
      id: 'ct1',
      type: 'contradiction',
      statement:
        'The triage names a policy cause while the customer later reports a name-resolution error.',
      conflictClass: 'source_disagreement',
      subject: 'cause of the sign-in failures',
      sides: [
        { eventId: eid('e02'), statement: 'The triage suspects a Conditional Access policy.' },
        {
          eventId: eid('e14'),
          statement: 'The customer reports a name-resolution error in the network log.',
        },
      ],
      ...tail([cite('e02', 'Likely a CA policy issue.'), cite('e14', 'ERR_NAME_NOT_RESOLVED')], {
        reasoning: 'The two events point at different causes.',
        confidenceBasis: 'inferred_from_sequence',
      }),
    },
    me1: {
      id: 'me1',
      type: 'missing_evidence',
      statement: 'No client trace existed when the root cause was declared.',
      requirementId: 'req.client-diagnostics',
      missing: 'A client network trace (HAR) from a failing sign-in',
      neededByEventId: eid('e07'),
      ...tail([cite('e04', TRACE_QUOTE)], {
        reasoning: 'The customer said the captures would take a while.',
      }),
    },
    ms1: {
      id: 'ms1',
      type: 'missed_step',
      statement:
        'A client trace had been asked for and was still outstanding when the change was proposed.',
      actionId: 'act.request-har-capture',
      step: 'Wait for the client trace before proposing a change to the policy',
      decisionEventId: eid('e08'),
      availableEventIds: [eid('e04')],
      ...tail([cite('e04', TRACE_QUOTE)], { confidenceBasis: 'inferred_from_sequence' }),
    },
    cf1: {
      id: 'cf1',
      type: 'counterfactual',
      statement:
        'Waiting for the client trace before revoking sessions might have pointed at the network path.',
      decisionEventId: eid('e09'),
      alternativeAction: 'Ask for the client trace and wait for it before revoking any sessions',
      informationThen:
        'The customer had said that captures would follow and that only the branch sites were affected.',
      expectedImmediateEffect:
        'The failing requests would have been visible before any session was revoked.',
      plausibleDownstreamEffect: 'The session revocation might not have been needed.',
      feasible: 'yes',
      constraints: ['The customer has to capture the trace while users are in calls'],
      skillId: null,
      validationNeeded: 'Check the trace of one failing sign-in for failed requests.',
      basis: 'model_estimate',
      ...tail([cite('e01', 'Users at our head office are not reporting the problem.')], {
        confidenceBasis: 'inferred_from_sequence',
      }),
    },
    rc1: {
      id: 'rc1',
      type: 'recommendation',
      statement: 'Look at how the branch sites resolve the sign-in host names.',
      action: 'Check how the affected sites resolve the sign-in host names',
      rationale: 'The network log summary shows failed lookups that no step has examined.',
      ownerRole: 'support_engineer',
      priority: 'high',
      ...tail([cite('e14', HAR_QUOTE)], { confidenceBasis: 'inferred_from_sequence' }),
    },
    sy1: {
      id: 'sy1',
      type: 'case_synthesis',
      statement: 'A cause was named at triage and acted on before any client trace existed.',
      summary:
        'The triage named a policy cause, the log review was read as confirming it, and sessions were revoked while the requested client trace was still outstanding. The later network log summary points at name resolution.',
      keyPoints: [
        {
          point: 'A policy cause was named at triage.',
          evidence: [cite('e02', 'Likely a CA policy issue.')],
        },
        {
          point: 'The cause was called confirmed after the log review.',
          evidence: [cite('e07', 'Root cause is the Conditional Access policy')],
        },
      ],
      openQuestions: ['Which step first examined the name-resolution errors?'],
      ...tail([cite('e09', 'Revoked refresh tokens and sessions for the 140 affected users')], {
        confidenceBasis: 'inferred_from_sequence',
      }),
    },
  };
}

/** The reasoner's whole reply: every grounded proposal filed under its list. */
export function validReply(): Record<string, unknown> {
  const p = validProposals();
  return {
    signals: [p.sg1, p.sg2],
    contradictions: [p.ct1],
    missingEvidence: [p.me1],
    missedSteps: [p.ms1],
    counterfactuals: [p.cf1],
    recommendations: [p.rc1],
    synthesis: p.sy1,
    uncertainty: { level: 'medium', note: 'Scripted reply over a synthetic case.' },
  };
}

/** The number of proposals of `validReply`. */
export const VALID_PROPOSAL_COUNT = 8;

export function reasonerTask(): Extract<AgentTask, { agent: 'case_reasoner' }> {
  return { agent: 'case_reasoner', input: baseOf(one, view) };
}

/** The default budget of one of the two review agents (the record is keyed by plain strings, so it may lack a key). */
export function budgetOf(agent: 'case_reasoner' | 'case_critic'): AgentBudget {
  const budget = DEFAULT_MODEL_CONFIG.agentBudgets[agent];
  if (!budget) throw new Error(`no default budget for ${agent}`);
  return budget;
}

const dependencies = new AiOrchestrator({ config: DEFAULT_MODEL_CONFIG }).prepareDependencies;

/** The validation context the pipeline builds for a task (no budget applied). */
export function vctxOf(task: AgentTask = reasonerTask()): ValidationContext {
  const { vctx } = prepareTask(task, 'req_case_one', 'm', dependencies, { applyBudget: false });
  if (!vctx) throw new Error('no validation context');
  return vctx;
}

/** What the grounding rules make of a reasoner reply over Case One. */
export const validateReasoner = (reply: unknown) =>
  validateProposalOutput('case_reasoner', reply, vctxOf(reasonerTask()));

/** The critic's reply: critiques of the conclusions with the given ids. */
export function criticReply(
  critiques: {
    targetId: string | null;
    kind?: string;
    explanation?: string;
    evidence?: { eventId: string; excerpt: string }[];
    alternativeHypothesisId?: string | null;
  }[],
  verdict = 'some_concerns',
): Record<string, unknown> {
  return {
    result: {
      id: 'cr1',
      type: 'critic_result',
      statement: 'Some conclusions go further than the record.',
      verdict,
      critiques: critiques.map((c) => ({
        targetId: c.targetId,
        kind: c.kind ?? 'unsupported_claim',
        explanation: c.explanation ?? 'The cited text does not state what the conclusion says.',
        evidence: c.evidence ?? [cite('e07', 'Root cause is the Conditional Access policy')],
        alternativeHypothesisId: c.alternativeHypothesisId ?? null,
      })),
      ...tail([cite('e07', 'Confirmed.')], {
        reasoning: 'Each conclusion was compared with the events it cites.',
        confidenceBasis: 'inferred_from_sequence',
        uncertainty: { level: 'medium', note: 'A scripted second look.' },
      }),
    },
    uncertainty: { level: 'medium', note: 'Scripted second look over a synthetic case.' },
  };
}

/** A critic reply with nothing to criticise. */
export const emptyCriticReply = (): Record<string, unknown> => ({
  result: null,
  uncertainty: { level: 'low', note: 'Nothing to add.' },
});

export interface ReviewHarness {
  orchestrator: AiOrchestrator;
  provider: ScriptedTestProvider;
  clock: FakeClock;
  logger: ReturnType<typeof capturingLogger>;
  metrics: ReturnType<typeof capturingMetrics>;
  deps: ReviewDeps;
}

/** An orchestrator over the scripted provider, with a fake clock and capturing logs and metrics. */
export function reviewHarness(
  script: Script,
  options: {
    config?: Partial<ModelConfig>;
    orchestrator?: Partial<AiOrchestratorOptions>;
    provider?: Partial<ScriptedProviderOptions>;
    maxRunTokens?: number;
  } = {},
): ReviewHarness {
  const clock = new FakeClock();
  const logger = capturingLogger();
  const metrics = capturingMetrics();
  const provider = createScriptedTestProvider({
    script,
    allowScripted: true,
    clock,
    ...options.provider,
  });
  let counter = 0;
  const orchestrator = new AiOrchestrator({
    config: {
      ...DEFAULT_MODEL_CONFIG,
      provider: 'scripted',
      azureDeployment: 'gpt-test',
      routing: { defaultModel: 'gpt-test', cheapModel: null, rules: [] },
      ...options.config,
    },
    provider,
    clock,
    logger,
    metrics,
    ids: { next: (prefix) => `${prefix}_${String(++counter).padStart(6, '0')}` },
    random: () => 0.5,
    ...options.orchestrator,
  });
  const deps: ReviewDeps = {
    orchestrator,
    clock,
    logger,
    metrics,
    ...(options.maxRunTokens === undefined ? {} : { maxRunTokens: options.maxRunTokens }),
  };
  return { orchestrator, provider, clock, logger, metrics, deps };
}

export function reviewInput(over: Partial<ReviewInput> = {}): ReviewInput {
  return { ...baseOf(one, view), ...over };
}

/** The conclusions the critic will be asked about, for the reply `validReply()`. */
export function conclusionsOf(reply: unknown = validReply()): ReviewConclusion[] {
  const kept: KeptProposal[] = validateReasoner(reply).proposals?.reasoner ?? [];
  return buildConclusions(deterministicFactsOf(one.analysis, { pack: one.pack }, { view }), kept);
}

export { CASE_ONE };
