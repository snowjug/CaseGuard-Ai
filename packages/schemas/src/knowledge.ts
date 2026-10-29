import { z } from 'zod';
import { TwinSectionSchema } from './case';
import { ProbabilitySchema } from './common';
import {
  ActionKindSchema,
  EffortLevelSchema,
  EventTypeSchema,
  EvidenceCategorySchema,
  HypothesisCategorySchema,
  ParticipantRoleSchema,
  StrengthSchema,
  WarningCategorySchema,
} from './enums';

/**
 * Workload knowledge pack.
 *
 * A pack is the *authored domain model* that the deterministic provider reasons with and that the
 * Azure OpenAI path receives as grounded context. Every number in it is an illustrative estimate
 * (assumption A-06), never measured production data. The pack is deliberately explicit so a
 * reviewer can read exactly why a hypothesis was promoted or demoted.
 */

export const SignalDetectorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('regex'),
    /** Authored by maintainers (trusted). Kept short and anchored to avoid pathological backtracking. */
    pattern: z.string().min(1).max(500),
    flags: z.string().max(8).default('i'),
    eventTypes: z.array(EventTypeSchema).optional(),
    roles: z.array(ParticipantRoleSchema).optional(),
  }),
  z.object({
    kind: z.literal('structured'),
    key: z.string().min(1).max(64),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'includes', 'exists']),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    eventTypes: z.array(EventTypeSchema).optional(),
  }),
  /** Several structured conditions on the same event that must ALL hold. */
  z.object({
    kind: z.literal('structured_all'),
    conditions: z
      .array(
        z.object({
          key: z.string().min(1).max(64),
          op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'includes', 'exists']),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        }),
      )
      .min(2)
      .max(6),
    eventTypes: z.array(EventTypeSchema).optional(),
  }),
]);
export type SignalDetector = z.infer<typeof SignalDetectorSchema>;

export const KnowledgeHypothesisSchema = z.object({
  id: z.string().regex(/^hyp\.[a-z0-9-]+$/),
  name: z.string().min(3).max(120),
  description: z.string().max(600),
  category: HypothesisCategorySchema,
  /** Prior probability before any case evidence. All priors in a pack sum to 1. */
  prior: ProbabilitySchema,
  assumptions: z.array(z.string().max(300)).default([]),
  /** Lexical cues that tie an engineer statement or action to this hypothesis. */
  keywords: z.array(z.string().min(2).max(60)).default([]),
  /** Preferred validating actions, cheapest safe first. */
  validatingActionIds: z.array(z.string()).default([]),
  /** Requirement ids that must be satisfied before this hypothesis may be treated as confirmed. */
  confirmationRequirementIds: z.array(z.string()).default([]),
});
export type KnowledgeHypothesis = z.infer<typeof KnowledgeHypothesisSchema>;

export const KnowledgeSignalSchema = z.object({
  id: z.string().regex(/^sig\.[a-z0-9-]+$/),
  label: z.string().min(3).max(120),
  description: z.string().max(400),
  detectors: z.array(SignalDetectorSchema).min(1),
  strength: StrengthSchema,
  evidenceKind: z.enum(['presence', 'absence']).default('presence'),
  /** Category used when the observation does not come from a customer-side participant. */
  category: EvidenceCategorySchema,
  /** P(signal observed | hypothesis). Hypotheses not listed use `neutral`. */
  likelihoods: z.record(z.string(), z.number().min(0.01).max(0.99)),
  neutral: z.number().min(0.01).max(0.99).default(0.5),
  explanation: z.string().max(500),
  /** Requirement ids satisfied by observing this signal. */
  satisfies: z.array(z.string()).default([]),
  /** Digital-twin section this observation belongs in (defaults to `observations`). */
  twinSection: TwinSectionSchema.optional(),
});
export type KnowledgeSignal = z.infer<typeof KnowledgeSignalSchema>;

export const ActionOutcomeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(3).max(160),
  /** Signals revealed by this outcome. Outcome probabilities derive from their likelihood tables. */
  emitsSignals: z.array(z.string()),
  /** Text rendered (and labelled simulated) when this outcome appears in a counterfactual path. */
  simulatedResult: z.string().max(500),
});
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;

export const ActionExecutorSchema = z.enum([
  'engineer',
  'customer_admin',
  'customer_network_admin',
  'customer_end_user',
  'system',
]);
export type ActionExecutor = z.infer<typeof ActionExecutorSchema>;

export const KnowledgeActionSchema = z.object({
  id: z.string().regex(/^act\.[a-z0-9-]+$/),
  label: z.string().min(3).max(160),
  description: z.string().max(500),
  kind: ActionKindSchema,
  executor: ActionExecutorSchema,
  valueClass: z.enum(['diagnostic', 'enabling', 'remediation', 'communication', 'validation']),
  /** Elapsed minutes including response latency for customer-executed actions (illustrative). */
  timeMinutes: z.object({
    min: z.number().min(0),
    typical: z.number().min(0),
    max: z.number().min(0),
  }),
  tokenEstimate: z.number().int().min(0).max(200_000),
  computeUnits: z.number().min(0).max(1000),
  customerEffort: EffortLevelSchema,
  operationalRisk: ProbabilitySchema,
  destructive: z.boolean(),
  requiresApproval: z.boolean(),
  /** Probability that the action runs and yields an interpretable result (the "Confidence" term). */
  reliability: z.number().min(0.05).max(1),
  requires: z.array(z.string()).default([]),
  produces: z.array(z.string()).default([]),
  /** Hypotheses this action is meant to test (the "Relevance" term). */
  targets: z.array(z.string()).default([]),
  outcomes: z.array(ActionOutcomeSchema).default([]),
  /** Detectors used to recognise this action in free-text engineer events. */
  detectors: z.array(SignalDetectorSchema).default([]),
  templates: z
    .object({
      kql: z.string().max(4000).optional(),
      powershell: z.string().max(4000).optional(),
    })
    .default({}),
  safetyNotes: z.string().max(400).optional(),
});
export type KnowledgeAction = z.infer<typeof KnowledgeActionSchema>;

export const KnowledgeRequirementSchema = z.object({
  id: z.string().regex(/^req\.[a-z0-9-]+$/),
  label: z.string().min(3).max(120),
  description: z.string().max(400),
  category: WarningCategorySchema,
  criticality: z.enum(['critical', 'important', 'helpful']),
  neededFrom: z.enum([
    'case_open',
    'first_engineer_request',
    'before_escalation',
    'before_closure',
  ]),
  askText: z.string().max(300),
  satisfiedBySignals: z.array(z.string()).default([]),
  satisfiedByDetectors: z.array(SignalDetectorSchema).default([]),
});
export type KnowledgeRequirement = z.infer<typeof KnowledgeRequirementSchema>;

export const ClaimPatternSchema = z.object({
  id: z.string().regex(/^clm\.[a-z0-9-]+$/),
  /** Attribute key used to detect conflicting statements, e.g. `affected_user_count`. */
  subject: z.string().min(2).max(60),
  pattern: z.string().min(1).max(400),
  flags: z.string().max(8).default('i'),
  /** Capture group holding the value (0 = whole match). */
  valueGroup: z.number().int().min(0).max(5).default(0),
  roles: z.array(ParticipantRoleSchema).optional(),
  eventTypes: z.array(EventTypeSchema).optional(),
  label: z.string().max(120),
});
export type ClaimPattern = z.infer<typeof ClaimPatternSchema>;

export const KnowledgeLexiconSchema = z.object({
  /** Hedging cues that mark an engineer statement as an assumption. */
  hedges: z.array(z.string().max(120)),
  /** Definitive causal phrasing that must be backed by diagnostic evidence. */
  definitive: z.array(z.string().max(160)),
  /** Customer-report cues. */
  customerReport: z.array(z.string().max(120)),
  /** Checklist / template phrasing that should not stand in for evidence. */
  template: z.array(z.string().max(160)),
  workaround: z.array(z.string().max(120)),
  permanentFix: z.array(z.string().max(120)),
  validation: z.array(z.string().max(120)),
  nextSteps: z.array(z.string().max(120)),
  expectation: z.array(z.string().max(120)),
  closure: z.array(z.string().max(120)),
  injection: z.array(z.string().max(200)).default([]),
});
export type KnowledgeLexicon = z.infer<typeof KnowledgeLexiconSchema>;

export const KnowledgePoliciesSchema = z.object({
  /** Posterior at which a hypothesis counts as "diagnosed" (assumption A-08). */
  diagnosisThreshold: ProbabilitySchema,
  /** Requirement ids that must be satisfied before escalation is considered justified. */
  minimumEvidenceForEscalation: z.array(z.string()),
  /** Posterior a hypothesis must reach before a destructive action targeting it is justified. */
  destructiveHypothesisThreshold: ProbabilitySchema,
  /** An action scoring below this share of the best candidate is flagged low value. */
  lowValueRelativeScore: ProbabilitySchema,
  lowValueInformationGainBits: z.number().min(0).max(5),
  repeatWindowMinutes: z.number().int().min(1),
  customerResponsePriorMinutes: z.object({
    min: z.number().min(0),
    typical: z.number().min(0),
    max: z.number().min(0),
  }),
  maxCounterfactualSteps: z.number().int().min(1).max(20),
  rolloutCount: z.number().int().min(20).max(2000),
  posteriorFloor: z.number().min(0.0001).max(0.2),
  strengthWeights: z.object({
    strong: z.number().min(0).max(1),
    moderate: z.number().min(0).max(1),
    weak: z.number().min(0).max(1),
  }),
  /** Minimum normalized gap between best and actual action for a fork to be "meaningful". */
  forkMinimumImpact: ProbabilitySchema,
});
export type KnowledgePolicies = z.infer<typeof KnowledgePoliciesSchema>;

export const KnowledgePackSchema = z.object({
  id: z.string().regex(/^kp\.[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  workload: z.string().min(1).max(80),
  title: z.string().min(3).max(160),
  description: z.string().max(600),
  /** Mandatory honesty statement displayed wherever pack-derived values appear. */
  disclaimer: z.string().min(20).max(500),
  hypotheses: z.array(KnowledgeHypothesisSchema).min(2),
  signals: z.array(KnowledgeSignalSchema).min(1),
  actions: z.array(KnowledgeActionSchema).min(1),
  requirements: z.array(KnowledgeRequirementSchema),
  claimPatterns: z.array(ClaimPatternSchema),
  lexicon: KnowledgeLexiconSchema,
  policies: KnowledgePoliciesSchema,
});
export type KnowledgePack = z.infer<typeof KnowledgePackSchema>;

/** The id reserved for probability mass the pack cannot attribute to a named hypothesis. */
export const OTHER_HYPOTHESIS_ID = 'hyp.other';

/**
 * Cross-reference integrity check. Returns human-readable problems (empty when the pack is sound).
 * Kept separate from the Zod schema so tests can assert on exact messages.
 */
export function validateKnowledgePackReferences(pack: KnowledgePack): string[] {
  const problems: string[] = [];
  const hypIds = new Set(pack.hypotheses.map((h) => h.id));
  const sigIds = new Set(pack.signals.map((s) => s.id));
  const actIds = new Set(pack.actions.map((a) => a.id));
  const reqIds = new Set(pack.requirements.map((r) => r.id));

  const priorSum = pack.hypotheses.reduce((sum, h) => sum + h.prior, 0);
  if (Math.abs(priorSum - 1) > 1e-6)
    problems.push(`hypothesis priors sum to ${priorSum.toFixed(4)}, expected 1`);
  if (!hypIds.has(OTHER_HYPOTHESIS_ID))
    problems.push(`missing catch-all hypothesis ${OTHER_HYPOTHESIS_ID}`);

  const dup = (ids: string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`duplicate ${what} id ${id}`);
      seen.add(id);
    }
  };
  dup(
    pack.hypotheses.map((h) => h.id),
    'hypothesis',
  );
  dup(
    pack.signals.map((s) => s.id),
    'signal',
  );
  dup(
    pack.actions.map((a) => a.id),
    'action',
  );
  dup(
    pack.requirements.map((r) => r.id),
    'requirement',
  );

  for (const s of pack.signals) {
    for (const h of Object.keys(s.likelihoods)) {
      if (!hypIds.has(h)) problems.push(`signal ${s.id} references unknown hypothesis ${h}`);
    }
    for (const r of s.satisfies)
      if (!reqIds.has(r)) problems.push(`signal ${s.id} satisfies unknown requirement ${r}`);
  }
  for (const a of pack.actions) {
    for (const r of [...a.requires, ...a.produces]) {
      if (!reqIds.has(r)) problems.push(`action ${a.id} references unknown requirement ${r}`);
    }
    for (const h of a.targets)
      if (!hypIds.has(h)) problems.push(`action ${a.id} targets unknown hypothesis ${h}`);
    for (const o of a.outcomes) {
      for (const s of o.emitsSignals)
        if (!sigIds.has(s))
          problems.push(`action ${a.id} outcome ${o.id} emits unknown signal ${s}`);
    }
    if (a.timeMinutes.min > a.timeMinutes.typical || a.timeMinutes.typical > a.timeMinutes.max) {
      problems.push(`action ${a.id} has non-monotonic timeMinutes`);
    }
  }
  for (const h of pack.hypotheses) {
    for (const a of h.validatingActionIds)
      if (!actIds.has(a)) problems.push(`hypothesis ${h.id} references unknown action ${a}`);
    for (const r of h.confirmationRequirementIds)
      if (!reqIds.has(r)) problems.push(`hypothesis ${h.id} references unknown requirement ${r}`);
  }
  for (const r of pack.requirements) {
    for (const s of r.satisfiedBySignals)
      if (!sigIds.has(s)) problems.push(`requirement ${r.id} references unknown signal ${s}`);
  }
  for (const r of pack.policies.minimumEvidenceForEscalation) {
    if (!reqIds.has(r)) problems.push(`policies reference unknown requirement ${r}`);
  }
  return problems;
}
