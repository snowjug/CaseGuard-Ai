import { analyzeView } from '@caseguard/domain';
import { AGENT_CATALOG } from '../agents/catalog';
import type { AgentTask, Hindsight, TaskBase } from '../agents/tasks';
import type { BuiltContext } from '../context/types';
import type { RegisteredPrompt } from '../prompts/registry';
import type { InjectionScanner } from '../types';
import { buildLeakGuard } from './leak-guard';
import { DEFAULT_VALIDATION_LIMITS, type ValidationContext, type ValidationLimits } from './types';

export interface ValidationDeps {
  scanInjection: InjectionScanner;
  maxAnalysisDepth: number;
  limits?: Partial<ValidationLimits> | undefined;
}

type CaseTask = Extract<AgentTask, { input: TaskBase }>;

const isCaseTask = (task: AgentTask): task is CaseTask =>
  task.agent !== 'token_governor' && task.agent !== 'safety_policy_validator';

function hindsightOf(task: CaseTask): Hindsight | null {
  if (task.agent === 'counterfactual_simulator') {
    return { events: task.input.events, resolution: task.input.resolution };
  }
  return task.input.hindsight ?? null;
}

/**
 * Assembles everything the validators need for one task: the context the model saw, the leak
 * guard (hindsight, never rendered into a prompt), and the knowledge state at the boundary.
 * Returns null for the deterministic-only agents, whose output only needs schema validation.
 */
export function buildValidationContext(
  task: AgentTask,
  built: BuiltContext,
  prompt: RegisteredPrompt,
  nonce: string | null,
  deps: ValidationDeps,
): ValidationContext | null {
  if (!isCaseTask(task)) return null;
  const { input } = task;
  const hindsight = hindsightOf(task);
  const temporal = AGENT_CATALOG[task.agent].temporalMode === 'pre_resolution';
  const maxSteps = Math.min(deps.maxAnalysisDepth, input.pack.pack.policies.maxCounterfactualSteps);
  return {
    agent: task.agent,
    built,
    pack: input.pack,
    config: input.config,
    limits: { ...DEFAULT_VALIDATION_LIMITS, maxSteps, ...deps.limits },
    leakGuard:
      temporal && hindsight
        ? buildLeakGuard({
            events: hindsight.events,
            resolution: hindsight.resolution,
            view: input.view,
            evidence: input.analysis.evidence,
            pack: input.pack,
          })
        : null,
    state:
      task.agent === 'counterfactual_simulator'
        ? analyzeView(input.view, input.pack, input.ctx.caseId).rankingState
        : null,
    scanInjection: deps.scanInjection,
    promptGuard: { templateShingles: prompt.templateShingles, nonce },
  };
}
