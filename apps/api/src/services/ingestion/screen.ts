import type { CaseBundle, InjectionFinding, InjectionSummary } from '@caseguard/schemas';
import { detectPromptInjection, summarizeInjection } from '@caseguard/security';

const YIELD_EVERY = 50;

const joined = (parts: readonly (string | undefined)[]): string =>
  parts.filter((part): part is string => part !== undefined && part.length > 0).join('\n');

/**
 * Screens the (already redacted) bundle for text that tries to instruct a model: every event's title,
 * body and action label, the resolution text, and the case-level labels. Flagged content is stored and
 * shown to reviewers, never dropped or acted on; only this summary (rule ids, severities and short
 * redacted excerpts) leaves the pipeline.
 */
export async function screenBundle(
  bundle: CaseBundle,
  pause: () => Promise<void>,
): Promise<InjectionSummary> {
  const findings: InjectionFinding[] = [];
  const labels = joined([
    bundle.case.title,
    bundle.case.product,
    bundle.case.customerAlias,
    ...bundle.case.tags,
    ...bundle.participants.map((participant) => participant.alias),
    bundle.syntheticNotice,
  ]);
  findings.push(...detectPromptInjection(labels, { eventId: null }));

  for (const [index, event] of bundle.events.entries()) {
    const text = joined([event.title, event.body, event.action?.label]);
    findings.push(...detectPromptInjection(text, { eventId: event.id }));
    if (index % YIELD_EVERY === YIELD_EVERY - 1) await pause();
  }

  const resolution = bundle.resolution;
  if (resolution !== undefined) {
    const text = joined([
      resolution.summary,
      resolution.rootCause,
      resolution.workaround,
      resolution.permanentFix,
      resolution.validation?.method,
    ]);
    findings.push(...detectPromptInjection(text, { eventId: null }));
  }
  return summarizeInjection(findings);
}
