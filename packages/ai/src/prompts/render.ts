import type { ModelMessage } from '../types';
import type { AgentContext } from '../context/types';
import { sha256Hex } from '../util/hash';
import type { RegisteredPrompt } from './registry';

export const DATA_OPEN = '<<<CASEGUARD_DATA';
export const DATA_CLOSE = '<<<END_CASEGUARD_DATA';

/** Per-request nonce so case text can never forge a block boundary it cannot predict. */
export function deriveNonce(requestId: string, templateHash: string): string {
  return sha256Hex(`${requestId}|${templateHash}`).slice(0, 16);
}

/**
 * Makes serialised JSON safe to embed in a delimited data block. Angle brackets are replaced by
 * their JSON unicode escapes (still the same string to any JSON reader), so case text cannot
 * contain a block delimiter, a chat-template token such as `<|im_start|>`, or markup.
 */
export function escapeForDataBlock(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function dataBlock(name: string, value: unknown, nonce: string): string {
  const body = escapeForDataBlock(JSON.stringify(value));
  return `${DATA_OPEN} name="${name}" nonce="${nonce}">>>\n${body}\n${DATA_CLOSE} nonce="${nonce}">>>`;
}

function boundarySentence(context: AgentContext): string {
  const { boundary } = context;
  if (boundary.temporalMode === 'post_hoc') {
    return boundary.resolutionIncluded
      ? `Boundary: post-hoc review of the whole record up to ${boundary.asOf} UTC, including the final resolution. Label anything that relies on the resolution as hindsight.`
      : `Boundary: post-hoc review of the whole record up to ${boundary.asOf} UTC. The final resolution is not provided.`;
  }
  const relation = boundary.mode === 'before' ? 'strictly before' : 'at or before';
  return `Boundary: use only information recorded ${relation} ${boundary.asOf} UTC. Later events and the final resolution are not available and must not be guessed.`;
}

export interface RenderOptions {
  nonce: string;
  /** Validator feedback for the single repair attempt (our own wording only; never case text). */
  repairFeedback?: readonly string[] | undefined;
}

/** Builds the chat messages: trusted instructions first, then untrusted data in delimited blocks. */
export function renderMessages(
  prompt: RegisteredPrompt,
  context: AgentContext,
  options: RenderOptions,
): ModelMessage[] {
  const { nonce } = options;
  const blocks: string[] = [];
  if (context.events.length > 0) blocks.push(dataBlock('events', context.events, nonce));
  if (context.evidence.length > 0) blocks.push(dataBlock('evidence', context.evidence, nonce));
  if (context.claims.length > 0) blocks.push(dataBlock('claims', context.claims, nonce));
  if (context.knowledge) blocks.push(dataBlock('knowledge', context.knowledge, nonce));
  if (Object.keys(context.focus).length > 0) blocks.push(dataBlock('focus', context.focus, nonce));

  const user = [
    prompt.task,
    boundarySentence(context),
    `Respond with one JSON object matching schema ${prompt.outputSchemaId}.`,
    ...blocks,
  ].join('\n\n');

  const messages: ModelMessage[] = [
    { role: 'system', content: prompt.systemMessage },
    { role: 'user', content: user },
  ];
  if (options.repairFeedback && options.repairFeedback.length > 0) {
    messages.push({
      role: 'user',
      content: `Your previous reply was rejected by validation. Fix these problems and reply again with one JSON object only:\n- ${options.repairFeedback.join('\n- ')}`,
    });
  }
  return messages;
}
