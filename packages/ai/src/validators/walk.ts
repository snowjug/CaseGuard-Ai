import type { AgentName } from '@caseguard/schemas';
import type { AgentOutputs } from '../agents/outputs';

export type CitationKind =
  | 'event'
  | 'anchor_event'
  | 'evidence'
  | 'claim'
  | 'hypothesis'
  | 'action'
  | 'requirement'
  | 'signal';

export interface CitationRef {
  path: string;
  id: string;
  kind: CitationKind;
  field: string;
}

/** Field-name convention: any property with one of these names is a reference to be resolved. */
const FIELD_KIND: Readonly<Record<string, CitationKind>> = {
  eventId: 'event',
  eventIds: 'event',
  fromEventId: 'event',
  toEventId: 'event',
  sourceEventIds: 'event',
  forkEventId: 'anchor_event',
  evidenceIds: 'evidence',
  evidenceUsedIds: 'evidence',
  supportingEvidenceIds: 'evidence',
  contradictingEvidenceIds: 'evidence',
  claimId: 'claim',
  claimIds: 'claim',
  actionKey: 'action',
  alternativeActionKey: 'action',
  cheapestSafeActionKey: 'action',
  suggestedActionKey: 'action',
  recommendedNextActionKey: 'action',
  triggerSignalIds: 'signal',
  minimumEvidenceRequirementIds: 'requirement',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every reference in an output, with the JSON path it was found at. */
export function collectCitations(output: unknown): CitationRef[] {
  const refs: CitationRef[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const kind =
        key === 'key' && /^hypotheses\[\d+\]$/.test(path)
          ? ('hypothesis' as const)
          : FIELD_KIND[key];
      if (kind !== undefined) {
        const ids = Array.isArray(value) ? value : [value];
        ids.forEach((id, i) => {
          if (typeof id === 'string') {
            refs.push({
              path: Array.isArray(value) ? `${childPath}[${i}]` : childPath,
              id,
              kind,
              field: key,
            });
          }
        });
      } else {
        visit(value, childPath);
      }
    }
  };
  visit(output, '');
  return refs;
}

/** Every free-text string in an output (reference fields excluded), with its JSON path. */
export function collectTexts(output: unknown): { path: string; text: string }[] {
  const texts: { path: string; text: string }[] = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      texts.push({ path, text: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const isReference = key in FIELD_KIND || (key === 'key' && /^hypotheses\[\d+\]$/.test(path));
      if (!isReference) visit(value, childPath);
    }
  };
  visit(output, '');
  return texts;
}

/** A statement in the output that should be supported by what it cites. */
export interface ClaimItem {
  path: string;
  text: string;
  events: string[];
  evidence: string[];
  claims: string[];
  /** Whether the item must cite at least one record (counterfactual and skill steps need not). */
  requireCitation: boolean;
  /** 'cited' checks lexical support against cited sources only; 'context' against everything shown. */
  supportScope: 'cited' | 'context';
}

export type TypedOutput = {
  [A in AgentName]: { agent: A; output: AgentOutputs[A] };
}[AgentName];

const item = (
  path: string,
  text: string,
  refs: Partial<Pick<ClaimItem, 'events' | 'evidence' | 'claims'>>,
  options: Partial<Pick<ClaimItem, 'requireCitation' | 'supportScope'>> = {},
): ClaimItem => ({
  path,
  text,
  events: refs.events ?? [],
  evidence: refs.evidence ?? [],
  claims: refs.claims ?? [],
  requireCitation: options.requireCitation ?? true,
  supportScope: options.supportScope ?? 'cited',
});

/** Statement-bearing items per agent (drives the groundedness / claim-support check). */
export function extractClaimItems(typed: TypedOutput): ClaimItem[] {
  switch (typed.agent) {
    case 'timeline_analyzer': {
      const o = typed.output;
      return [
        ...o.keyMoments.map((m, i) =>
          item(`keyMoments[${i}]`, `${m.label}. ${m.note}`, { events: [m.eventId] }),
        ),
        ...o.delays.map((d, i) =>
          item(`delays[${i}]`, d.note, { events: [d.fromEventId, d.toEventId] }),
        ),
        ...o.repeatedDiagnostics.map((r, i) =>
          item(`repeatedDiagnostics[${i}]`, r.note, { events: r.eventIds }),
        ),
      ];
    }
    case 'evidence_classifier':
      return typed.output.classifications.map((c, i) =>
        item(`classifications[${i}]`, c.rationale, {
          events: c.eventIds,
          evidence: c.evidenceIds,
          claims: [c.claimId],
        }),
      );
    case 'hypothesis_generator':
      return typed.output.hypotheses.map((h, i) =>
        item(`hypotheses[${i}]`, h.rationale, {
          events: h.eventIds,
          evidence: [...h.supportingEvidenceIds, ...h.contradictingEvidenceIds],
        }),
      );
    case 'decision_fork_detector':
      return typed.output.forks.map((f, i) =>
        item(`forks[${i}]`, f.rationale, { events: [f.eventId], evidence: f.evidenceIds }),
      );
    case 'counterfactual_simulator':
      return typed.output.steps.map((s, i) =>
        item(
          `steps[${i}]`,
          s.rationale,
          { evidence: s.evidenceUsedIds },
          { requireCitation: false, supportScope: 'context' },
        ),
      );
    case 'quality_judge': {
      const o = typed.output;
      return [
        ...o.findings.map((f, i) =>
          item(`findings[${i}]`, f.finding, {
            events: f.eventIds,
            evidence: f.evidenceIds,
            claims: f.claimIds,
          }),
        ),
        ...o.strengths.map((s, i) =>
          item(`strengths[${i}]`, s.note, { events: s.eventIds, evidence: s.evidenceIds }),
        ),
      ];
    }
    case 'skilldna_extractor': {
      const o = typed.output;
      return [
        item(
          'description',
          o.description,
          { events: o.sourceEventIds },
          { supportScope: 'context' },
        ),
        ...o.steps.map((s, i) =>
          item(
            `steps[${i}]`,
            `${s.title}. ${s.instruction}`,
            { events: s.eventIds, evidence: s.evidenceIds },
            { requireCitation: false, supportScope: 'context' },
          ),
        ),
      ];
    }
    case 'communication_coach': {
      const o = typed.output;
      const sections: [string, typeof o.wentWell][] = [
        ['wentWell', o.wentWell],
        ['evidenceQuality', o.evidenceQuality],
        ['reasoningImprovements', o.reasoningImprovements],
        ['communicationImprovements', o.communicationImprovements],
        ['customerEffortImprovements', o.customerEffortImprovements],
      ];
      const notes = sections.flatMap(([name, list]) =>
        list.map((n, i) =>
          item(`${name}[${i}]`, `${n.title}. ${n.detail}`, {
            events: n.eventIds,
            evidence: n.evidenceIds,
            claims: n.claimIds,
          }),
        ),
      );
      const missed = o.missedOpportunity
        ? [
            item(
              'missedOpportunity',
              `${o.missedOpportunity.title}. ${o.missedOpportunity.detail}`,
              {
                events: o.missedOpportunity.eventIds,
                evidence: o.missedOpportunity.evidenceIds,
                claims: o.missedOpportunity.claimIds,
              },
            ),
          ]
        : [];
      return [...notes, ...missed];
    }
    case 'token_governor':
    case 'safety_policy_validator':
    case 'case_reasoner':
    case 'case_critic':
      return [];
  }
}

/** Free-text fields that read as recommendations (unsafe-wording policy applies to these). */
export function recommendationTexts(typed: TypedOutput): { path: string; text: string }[] {
  switch (typed.agent) {
    case 'quality_judge':
      return typed.output.findings.flatMap((f, i) =>
        f.suggestedImprovement
          ? [{ path: `findings[${i}].suggestedImprovement`, text: f.suggestedImprovement }]
          : [],
      );
    case 'skilldna_extractor':
      return [
        ...typed.output.steps.flatMap((s, i) => [
          { path: `steps[${i}].title`, text: s.title },
          { path: `steps[${i}].instruction`, text: s.instruction },
        ]),
        ...typed.output.escalationConditions.map((text, i) => ({
          path: `escalationConditions[${i}]`,
          text,
        })),
      ];
    case 'communication_coach': {
      const o = typed.output;
      const lists: [string, typeof o.wentWell][] = [
        ['reasoningImprovements', o.reasoningImprovements],
        ['communicationImprovements', o.communicationImprovements],
        ['customerEffortImprovements', o.customerEffortImprovements],
      ];
      return [
        ...lists.flatMap(([name, list]) =>
          list.flatMap((n, i) => [
            { path: `${name}[${i}].title`, text: n.title },
            { path: `${name}[${i}].detail`, text: n.detail },
          ]),
        ),
        ...(o.missedOpportunity
          ? [{ path: 'missedOpportunity.detail', text: o.missedOpportunity.detail }]
          : []),
      ];
    }
    case 'counterfactual_simulator':
      return typed.output.steps.flatMap((s, i) => [
        { path: `steps[${i}].rationale`, text: s.rationale },
        { path: `steps[${i}].expectedOutcome`, text: s.expectedOutcome },
      ]);
    case 'hypothesis_generator':
      return [];
    case 'timeline_analyzer':
    case 'evidence_classifier':
    case 'decision_fork_detector':
    case 'token_governor':
    case 'safety_policy_validator':
    case 'case_reasoner':
    case 'case_critic':
      return [];
  }
}
