import { ProviderError } from '../../errors';
import type { FinishReason, ModelUsage } from '../../types';
import { parseModelJson } from '../../util/json';
import { estimateTokens } from '../../util/text';

export interface ParsedCompletion {
  output: unknown;
  outputText: string | null;
  parseError: string | null;
  usage: ModelUsage;
  model: string;
  finishReason: FinishReason;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

function finishReasonOf(value: unknown): FinishReason {
  if (value === 'stop' || value === 'length' || value === 'content_filter') return value;
  return 'other';
}

/**
 * Parses a successful chat-completions envelope. Content-filter verdicts, refusals and tool calls
 * are surfaced as typed errors; usage is taken from the response when present and estimated
 * (and labelled so) when it is not.
 */
export function parseChatCompletion(
  bodyText: string,
  fallbackModel: string,
  promptText: string,
): ParsedCompletion {
  let envelope: unknown;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    throw new ProviderError('invalid_response', 'The Azure OpenAI response was not valid JSON.');
  }
  if (!isRecord(envelope) || !Array.isArray(envelope.choices)) {
    throw new ProviderError('invalid_response', 'The Azure OpenAI response had no choices.');
  }
  const choice: unknown = envelope.choices[0];
  if (!isRecord(choice)) {
    throw new ProviderError(
      'invalid_response',
      'The Azure OpenAI response had an empty choice list.',
    );
  }
  const finishReason = finishReasonOf(choice.finish_reason);
  if (finishReason === 'content_filter') {
    throw new ProviderError(
      'content_filtered',
      'The response was blocked by the Azure OpenAI content filter.',
    );
  }
  const message = isRecord(choice.message) ? choice.message : {};
  if (
    choice.finish_reason === 'tool_calls' ||
    message.tool_calls !== undefined ||
    message.function_call !== undefined
  ) {
    throw new ProviderError(
      'tool_call_blocked',
      'The model attempted a tool call; no tools are available.',
    );
  }
  if (typeof message.refusal === 'string' && message.refusal.length > 0) {
    throw new ProviderError('model_refusal', 'The model declined to answer the request.');
  }
  const content = typeof message.content === 'string' ? message.content : null;

  const usage = isRecord(envelope.usage) ? envelope.usage : null;
  const promptTokens = toCount(usage?.prompt_tokens);
  const completionTokens = toCount(usage?.completion_tokens);
  const details =
    usage && isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const cachedTokens = toCount(details?.cached_tokens) ?? 0;
  const measured = promptTokens !== null && completionTokens !== null;
  const prompt = promptTokens ?? estimateTokens(promptText);
  const completion = completionTokens ?? estimateTokens(content ?? '');

  const parsed = content === null ? null : parseModelJson(content);
  return {
    output: parsed?.ok ? parsed.value : undefined,
    outputText: content,
    parseError:
      parsed === null ? 'The model returned no content.' : parsed.ok ? null : parsed.error,
    usage: {
      promptTokens: prompt,
      completionTokens: completion,
      cachedTokens,
      totalTokens: toCount(usage?.total_tokens) ?? prompt + completion,
      source: measured ? 'measured' : 'estimated',
    },
    model:
      typeof envelope.model === 'string' && envelope.model.length > 0
        ? envelope.model.slice(0, 120)
        : fallbackModel,
    finishReason,
  };
}
