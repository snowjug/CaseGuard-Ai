import { DEFAULT_MODEL_CONFIG, type AgentName, type ModelConfig } from '@caseguard/schemas';
import {
  AiOrchestrator,
  type AgentRunRequest,
  type AgentTask,
  type AiOrchestratorOptions,
  type ModelProvider,
} from '../src';
import { CASE_ONE, prepareCase } from './helpers';
import { FakeClock, capturingLogger, capturingMetrics } from './fakes';
import { hypothesisTask, validOutput, viewUpTo } from './tasks';

export const one = prepareCase(CASE_ONE);

/** An orchestrator wired with a fake clock, deterministic ids and capturing logs/metrics. */
export function setup(
  provider?: ModelProvider,
  patch: Partial<ModelConfig> = {},
  extra: Partial<AiOrchestratorOptions> = {},
) {
  const clock = new FakeClock();
  const logger = capturingLogger();
  const metrics = capturingMetrics();
  let counter = 0;
  const orchestrator = new AiOrchestrator({
    config: {
      ...DEFAULT_MODEL_CONFIG,
      provider: provider ? 'azure-openai' : 'deterministic',
      azureDeployment: 'gpt-test',
      routing: { defaultModel: 'gpt-test', cheapModel: null, rules: [] },
      ...patch,
    },
    ...(provider ? { provider } : {}),
    clock,
    logger,
    metrics,
    ids: { next: (prefix) => `${prefix}_${String(++counter).padStart(6, '0')}` },
    random: () => 0.5,
    ...extra,
  });
  return { orchestrator, clock, logger, metrics };
}

export const hypTask = hypothesisTask(one, viewUpTo(one, 'e14'));
export const good = () => validOutput(hypTask);

export const hallucinated = () => {
  const out = good();
  const item = out.hypotheses[0];
  if (item) item.eventIds = ['e99'];
  return out;
};

export const destructive = () => {
  const out = good();
  const item = out.hypotheses[0];
  if (item) item.cheapestSafeActionKey = 'act.revoke-user-sessions';
  return out;
};

export const run = (
  o: AiOrchestrator,
  task: AgentTask = hypTask,
  extra: Partial<Omit<AgentRunRequest<AgentName>, 'task'>> = {},
) => o.runAgentTask({ task, ...extra });
