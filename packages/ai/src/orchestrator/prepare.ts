import type { AgentBudget } from '@caseguard/schemas';
import type { AgentTask } from '../agents/tasks';
import type { CacheInput, CacheScope } from '../cache/semantic-cache';
import { buildContext, type ContextDeps } from '../context/build';
import type { BuiltContext } from '../context/types';
import { fitContextToBudget, type FitResult } from '../governor/fit';
import type { TokenGovernor } from '../governor/token-governor';
import { deriveNonce, renderMessages } from '../prompts/render';
import type { PromptRegistry, RegisteredPrompt } from '../prompts/registry';
import type { InjectionScanner, ModelMessage, Redactor } from '../types';
import { redactSecrets } from '../util/redact';
import { estimateTokens, normalizeText } from '../util/text';
import { buildValidationContext } from '../validators/context';
import type { ValidationContext, ValidationLimits } from '../validators/types';

export interface PrepareDeps {
  registry: PromptRegistry;
  governor: TokenGovernor;
  /** Case text is always passed through the built-in secret masker, then through this redactor. */
  redact: Redactor;
  scanInjection: InjectionScanner;
  validationLimits?: Partial<ValidationLimits> | undefined;
}

export interface PreparedTask {
  task: AgentTask;
  prompt: RegisteredPrompt;
  limits: AgentBudget;
  fit: FitResult;
  messages: ModelMessage[];
  nonce: string;
  /** Null for deterministic-only agents (their output needs schema validation only). */
  vctx: ValidationContext | null;
  /** Null when the task is not cacheable (no case boundary). */
  cacheScope: CacheScope | null;
  cacheInput: CacheInput | null;
}

const PLACEHOLDER_NONCE = '0'.repeat(16);

const isStatic = (task: AgentTask): boolean =>
  task.agent === 'token_governor' || task.agent === 'safety_policy_validator';

function cacheKeysFor(
  task: AgentTask,
  prompt: RegisteredPrompt,
  contextHash: string,
  text: string,
  model: string,
): { scope: CacheScope | null; input: CacheInput | null } {
  if (task.agent === 'token_governor' || task.agent === 'safety_policy_validator') {
    return { scope: null, input: null };
  }
  const { view, pack, tenantId, caseId } = task.input;
  return {
    scope: {
      tenantId,
      caseId,
      agent: task.agent,
      promptHash: prompt.templateHash,
      packVersion: `${pack.pack.id}@${pack.pack.version}`,
      boundaryKey: `${view.mode}:${view.asOf}:${view.fingerprint}|${model}`,
    },
    input: { hash: contextHash, text: normalizeText(text) },
  };
}

/**
 * Builds everything needed to call (or evaluate) a model for one task: the minimised context at
 * the least-compressed level that fits the budget, the rendered messages, the validation context
 * and the cache keys. Pure; shared by the orchestrator and the evaluation harness.
 */
export function prepareTask(
  task: AgentTask,
  requestId: string,
  model: string,
  deps: PrepareDeps,
  options: { applyBudget: boolean },
): PreparedTask {
  const prompt = deps.registry.get(task.agent);
  const limits = deps.governor.limitsFor(task.agent);
  const config = deps.governor.modelConfig;
  const redact: Redactor = (text) => deps.redact(redactSecrets(text));
  const contextDeps: ContextDeps = {
    redact,
    scanInjection: deps.scanInjection,
    maxAnalysisDepth: config.maxAnalysisDepth,
  };
  const measure = (built: BuiltContext): number =>
    estimateTokens(
      renderMessages(prompt, built.context, { nonce: PLACEHOLDER_NONCE })
        .map((m) => m.content)
        .join('\n'),
    );
  const fit = fitContextToBudget({
    buildAt: (level) => buildContext(task, level, contextDeps),
    measure,
    maxInputTokens:
      options.applyBudget && !isStatic(task) ? limits.maxInputTokens : Number.MAX_SAFE_INTEGER,
  });
  const nonce = deriveNonce(requestId, prompt.templateHash);
  const messages = renderMessages(prompt, fit.built.context, { nonce });
  const keys = cacheKeysFor(task, prompt, fit.built.contextHash, fit.built.allText, model);
  return {
    task,
    prompt,
    limits,
    fit,
    messages,
    nonce,
    vctx: buildValidationContext(task, fit.built, prompt, nonce, {
      scanInjection: deps.scanInjection,
      maxAnalysisDepth: config.maxAnalysisDepth,
      limits: deps.validationLimits,
    }),
    cacheScope: keys.scope,
    cacheInput: keys.input,
  };
}

/** Estimated prompt tokens of already rendered messages. */
export const messageTokens = (messages: readonly ModelMessage[]): number =>
  estimateTokens(messages.map((m) => m.content).join('\n'));
