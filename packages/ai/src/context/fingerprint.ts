import { hashJson } from '../util/hash';
import type { AgentContext } from './types';

const blank = (text: string | null): string | null => (text === null ? null : '');

/**
 * The context with its prose emptied. Prose is only the free text of events and the evidence and
 * claim text derived from it. Everything else (ids, times, types, roles, flags, strengths, the
 * boundary, the trim level, the knowledge catalogue and the agent-specific focus such as the
 * strategy, the allowed actions or the scenario) is structure. Anything added to the context later
 * is structure by default, which is the safe direction for a cache key.
 */
export function contextStructure(context: AgentContext): AgentContext {
  return {
    ...context,
    events: context.events.map((e) => ({ ...e, title: blank(e.title), text: blank(e.text) })),
    evidence: context.evidence.map((e) => ({ ...e, summary: '', excerpt: blank(e.excerpt) })),
    claims: context.claims.map((c) => ({ ...c, text: '' })),
  };
}

/**
 * Hash of everything that makes two requests different requests. Requests may only share a cache
 * bucket when this matches exactly; lexical near-matching then varies over the prose alone, so a
 * different strategy, fork, scenario, claim subset or trim level can never be served from another
 * request's entry however few words it changes.
 */
export const contextStructureKey = (context: AgentContext): string =>
  hashJson(contextStructure(context));

/** The prose of a context: event titles and bodies, and the evidence and claim text derived from them. */
export function contextProse(context: AgentContext): string {
  const parts: string[] = [];
  for (const e of context.events) parts.push(e.title ?? '', e.text ?? '');
  for (const e of context.evidence) parts.push(e.summary, e.excerpt ?? '');
  for (const c of context.claims) parts.push(c.text);
  return parts.filter((part) => part.length > 0).join('\n');
}
