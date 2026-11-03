import {
  SKILL_QUALITY_DIMENSIONS,
  SKILL_QUALITY_DIMENSION_LABELS,
  type SkillContent,
  type SkillDna,
  type SkillMatch,
  type SkillQualityAssessment,
  type SkillQualityDimension,
  type SkillQualityIssue,
  type SkillQualityRating,
  type SkillUseAssessment,
  type SkillVersion,
} from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { isSafeConditionPattern } from './evidence';

/**
 * Whether a SkillDNA skill is genuinely reusable (wave 2). Everything is read from what the skill records: its triggers, the
 * evidence behind it, the actions it recommends, who reviewed it and what it has done so far. Nothing is learned and nothing
 * is written: the result explains and flags, and approval, retirement and every other decision stay with governance.
 */

/** A skill not validated for this long is flagged. */
export const STALE_AFTER_DAYS = 180;
/** Overlap of two skills' trigger signals at which they describe the same situation. */
export const SAME_SITUATION_SIMILARITY = 0.8;
/** How much more likely a signal is under one cause than under the least likely one, for it to tell the two apart. */
const DISCRIMINATION_RATIO = 2;

type Content = SkillContent;
type Condition = Content['triggerConditions'][number];

export interface LibrarySkill {
  readonly skill: Pick<SkillDna, 'id' | 'tenantId' | 'workload' | 'lifecycle' | 'name'>;
  readonly content: SkillContent;
}

export interface SkillQualityInput {
  readonly skill: SkillDna;
  readonly version: Pick<
    SkillVersion,
    'id' | 'state' | 'changeSummary' | 'changeType' | 'parentVersionId'
  > & { readonly content: SkillContent };
  readonly pack: CompiledPack;
  /** The other skills of the tenant (this one may be among them and is ignored). */
  readonly library: readonly LibrarySkill[];
  readonly now: string;
  /** The tenant that is reading the skill. */
  readonly tenantId: string;
}

interface Rated {
  readonly rating: SkillQualityRating;
  readonly findings: string[];
}

const plural = (n: number, word: string, many = `${word}s`): string =>
  `${n} ${n === 1 ? word : many}`;

const sortedSteps = (content: Content): Content['decisionSequence'] =>
  [...content.decisionSequence].sort((a, b) => a.order - b.order);

const firstActionKey = (content: Content): string | null =>
  sortedSteps(content).find((step) => step.actionKey !== null)?.actionKey ?? null;

const signalIds = (content: Content): string[] =>
  content.triggerConditions.flatMap((c) =>
    c.kind === 'signal' && c.signalId !== undefined ? [c.signalId] : [],
  );

/** Whether a signal tells one cause from another: some cause makes it at least twice as likely as the least likely one. */
function discriminates(pack: CompiledPack, signalId: string): boolean {
  const signal = pack.signals.get(signalId);
  if (signal === undefined) return false;
  const likelihoods = pack.hypothesisIds.map((id) => signal.likelihoods[id] ?? signal.neutral);
  if (likelihoods.length === 0) return false;
  return (
    Math.max(...likelihoods) / Math.max(Math.min(...likelihoods), 0.02) >= DISCRIMINATION_RATIO
  );
}

const GENERIC_NAME =
  /\b(general|generic|best[- ]practices?|troubleshoot(?:ing)?|checklist|overview|basics?|guide|everything)\b/i;
const CAUSAL_LANGUAGE =
  /\b(?:root cause|is caused by|are caused by|was caused by|the cause is|the cause was|caused by|because of)\b/i;

// ---------------------------------------------------------------- the twelve dimensions

function specificity({ version, pack }: SkillQualityInput): Rated {
  const triggers = version.content.triggerConditions;
  const required = triggers.filter((c) => c.required);
  const telling = signalIds(version.content).filter((id) => discriminates(pack, id));
  const findings = [`${plural(triggers.length, 'trigger')}, ${required.length} required.`];
  if (telling.length === 0)
    findings.push('No trigger is a signal that tells one cause from another.');
  if (GENERIC_NAME.test(version.content.name)) {
    findings.push('The name reads like a general guide, not a situation to recognise.');
  }
  const rating: SkillQualityRating =
    triggers.length === 0
      ? 'missing'
      : telling.length >= 2 && required.length >= 1
        ? 'strong'
        : telling.length >= 1
          ? 'adequate'
          : 'weak';
  return { rating, findings };
}

function evidenceBasis({ skill, version }: SkillQualityInput): Rated {
  const cases = version.content.sourceCases;
  const origin = cases.filter((c) => c.role === 'origin').length;
  const validation = cases.filter((c) => c.role === 'validation').length;
  const evidence = version.content.minimumEvidence.length;
  const findings = [
    `${plural(cases.length, 'source case')} (${origin} origin, ${validation} validation); ${plural(evidence, 'minimum-evidence item')}.`,
  ];
  if (cases.length === 1) findings.push('It came from one case only.');
  if (skill.synthetic) findings.push('Every source case is synthetic.');
  const rating: SkillQualityRating =
    cases.length === 0
      ? 'missing'
      : origin >= 1 && validation >= 1 && evidence >= 2
        ? 'strong'
        : origin >= 1 && evidence >= 1
          ? 'adequate'
          : 'weak';
  return { rating, findings };
}

function triggerConditions({ version, pack }: SkillQualityInput): Rated {
  const triggers = version.content.triggerConditions;
  const findings: string[] = [];
  const known = triggers.filter(
    (c): c is Condition & { signalId: string } =>
      c.kind === 'signal' && c.signalId !== undefined && pack.signals.has(c.signalId),
  );
  const unknown = triggers.filter(
    (c) => c.kind === 'signal' && (c.signalId === undefined || !pack.signals.has(c.signalId)),
  );
  const unsafe = triggers.filter(
    (c) => c.kind === 'text' && (c.pattern === undefined || !isSafeConditionPattern(c.pattern)),
  );
  const weightless = triggers.filter((c) => c.weight === 0);
  if (unknown.length > 0) {
    findings.push(
      `${plural(unknown.length, 'trigger')} name a signal the knowledge pack does not have.`,
    );
  }
  if (unsafe.length > 0) {
    findings.push(`${plural(unsafe.length, 'text condition')} cannot be run safely.`);
  }
  if (weightless.length > 0)
    findings.push(`${plural(weightless.length, 'trigger')} carry no weight.`);
  const problems = unknown.length + unsafe.length + weightless.length;
  findings.push(
    `${known.length} signal trigger${known.length === 1 ? '' : 's'} of ${triggers.length}; ${known.filter((c) => c.required).length} required.`,
  );
  const rating: SkillQualityRating =
    triggers.length === 0
      ? 'missing'
      : problems === 0 && triggers.length >= 2 && known.some((c) => c.required)
        ? 'strong'
        : known.length >= 1 && unsafe.length === 0
          ? 'adequate'
          : 'weak';
  return { rating, findings };
}

function requiredContext({ version }: SkillQualityInput): Rated {
  const inputs = version.content.requiredInputs.filter((r) => r.required).length;
  const evidence = version.content.minimumEvidence.length;
  const findings = [
    `${plural(inputs, 'required input')}; ${plural(evidence, 'minimum-evidence item')}.`,
  ];
  if (inputs === 0 && evidence === 0)
    findings.push('It does not say what it needs before it can be applied.');
  const rating: SkillQualityRating =
    inputs >= 1 && evidence >= 1 ? 'strong' : inputs + evidence >= 1 ? 'adequate' : 'missing';
  return { rating, findings };
}

function prohibitedContext({ version }: SkillQualityInput): Rated {
  const { exclusions, stopConditions, escalationConditions, safetyConstraints } = version.content;
  const stops = stopConditions.length + escalationConditions.length;
  const findings = [
    `${plural(exclusions.length, 'exclusion')}; ${plural(stops, 'stop or escalation condition')}; ${plural(safetyConstraints.length, 'safety constraint')}.`,
  ];
  if (exclusions.length === 0) findings.push('It names no situation where it must not be used.');
  const rating: SkillQualityRating =
    exclusions.length >= 1 && stops >= 1
      ? 'strong'
      : exclusions.length >= 1 || stops >= 1
        ? 'adequate'
        : safetyConstraints.length >= 1
          ? 'weak'
          : 'missing';
  return { rating, findings };
}

/** Rated so that "strong" means a low risk of matching the wrong case. */
function falsePositiveRisk({ version, pack }: SkillQualityInput): Rated {
  const { triggerConditions: triggers, exclusions } = version.content;
  const telling = signalIds(version.content).filter((id) => discriminates(pack, id));
  const reasons: string[] = [];
  let points = 0;
  if (!triggers.some((c) => c.required)) {
    points += 2;
    reasons.push('no trigger is required');
  }
  if (telling.length < 2) {
    points += 1;
    reasons.push('fewer than two triggers tell causes apart');
  }
  if (exclusions.length === 0) {
    points += 1;
    reasons.push('no exclusion');
  }
  if (triggers.every((c) => c.kind !== 'signal')) {
    points += 1;
    reasons.push('no trigger is a signal of the knowledge pack');
  }
  if (triggers.length === 1) {
    points += 1;
    reasons.push('a single trigger');
  }
  const level = points === 0 ? 'low' : points === 1 ? 'moderate' : 'high';
  return {
    rating: points === 0 ? 'strong' : points === 1 ? 'adequate' : 'weak',
    findings: [
      reasons.length === 0
        ? 'Estimated risk of matching the wrong case: low.'
        : `Estimated risk of matching the wrong case: ${level}, because ${reasons.join(', ')}.`,
    ],
  };
}

function transferability({ skill, version }: SkillQualityInput): Rated {
  const applicability = version.content.applicability;
  if (applicability === undefined) {
    return {
      rating: 'missing',
      findings: ['It does not say where it applies or where it has not been validated.'],
    };
  }
  const findings = [
    `Validated on ${plural(applicability.validatedOnCases, 'case')}; ${plural(applicability.limitations.length, 'stated limitation')}.`,
  ];
  if (skill.synthetic)
    findings.push('Every contributing case is synthetic, so transfer to real cases is untested.');
  const rating: SkillQualityRating =
    applicability.validatedOnCases >= 3 && applicability.limitations.length >= 1
      ? 'strong'
      : applicability.validatedOnCases >= 1 && applicability.limitations.length >= 1
        ? 'adequate'
        : 'weak';
  return { rating, findings };
}

function expectedAction({ version, pack }: SkillQualityInput): Rated {
  const steps = version.content.decisionSequence;
  const withAction = steps.filter((step) => step.actionKey !== null);
  const known = withAction.filter(
    (step) => step.actionKey !== null && pack.actions.has(step.actionKey),
  );
  const unknown = withAction.length - known.length;
  const findings = [
    `${known.length} of ${plural(steps.length, 'step')} map${known.length === 1 ? 's' : ''} to an action in the knowledge pack.`,
  ];
  if (unknown > 0)
    findings.push(`${plural(unknown, 'step')} name an action the knowledge pack does not have.`);
  const ratio = steps.length === 0 ? 0 : known.length / steps.length;
  const rating: SkillQualityRating =
    withAction.length === 0
      ? 'missing'
      : unknown > 0
        ? 'weak'
        : ratio >= 0.8
          ? 'strong'
          : ratio >= 0.5
            ? 'adequate'
            : 'weak';
  return { rating, findings };
}

function outcomeEvidence({ version }: SkillQualityInput): Rated {
  const { successConditions, decisionSequence, validationCriteria, expectedBenefit } =
    version.content;
  const branches = decisionSequence
    .flatMap((step) => step.branches)
    .filter((b) => b.outcomeId !== undefined);
  const findings = [
    `${plural(successConditions.length, 'success condition')}; ${plural(branches.length, 'branch', 'branches')} tied to an expected outcome.`,
  ];
  if (expectedBenefit !== undefined) {
    findings.push('The stated benefit is a simulated estimate, not a measurement.');
  }
  const rating: SkillQualityRating =
    successConditions.length >= 1 && branches.length >= 2 && (validationCriteria?.length ?? 0) >= 1
      ? 'strong'
      : successConditions.length >= 1 && branches.length >= 1
        ? 'adequate'
        : successConditions.length >= 1 || branches.length >= 1
          ? 'weak'
          : 'missing';
  return { rating, findings };
}

const LIFECYCLE_RANK: Readonly<Record<SkillDna['lifecycle'], number>> = {
  discovered: 0,
  draft: 1,
  simulation_tested: 2,
  expert_reviewed: 3,
  pilot: 4,
  validated: 5,
  published: 6,
  deprecated: 1,
  retired: 0,
};

function governanceStatus({ skill }: SkillQualityInput): Rated {
  const findings = [
    `Lifecycle: ${skill.lifecycle.replace('_', ' ')}; validation: ${skill.validationStatus.replace('_', ' ')}.`,
  ];
  const independent = skill.reviewer !== null && skill.reviewer !== skill.owner;
  if (!independent) findings.push('No reviewer other than its owner has looked at it.');
  if (skill.lifecycle === 'deprecated' || skill.lifecycle === 'retired') {
    findings.push('It is no longer suggested to engineers.');
  }
  const rank = LIFECYCLE_RANK[skill.lifecycle];
  const rating: SkillQualityRating =
    skill.lifecycle === 'validated' || skill.lifecycle === 'published'
      ? independent &&
        (skill.validationStatus === 'pilot_validated' || skill.validationStatus === 'validated')
        ? 'strong'
        : 'adequate'
      : rank >= 4
        ? 'adequate'
        : rank >= 1
          ? 'weak'
          : 'missing';
  return { rating, findings };
}

function versionRating({ skill, version }: SkillQualityInput): Rated {
  const findings = [`Version ${skill.currentVersion}, ${version.state}.`];
  if (version.changeSummary.trim().length < 10) findings.push('The change is not described.');
  if (version.changeType !== 'initial' && version.parentVersionId === null) {
    findings.push('It is a later version but names no earlier one.');
  }
  const rating: SkillQualityRating =
    version.state === 'active'
      ? version.changeSummary.trim().length >= 10 &&
        (version.changeType === 'initial' || version.parentVersionId !== null)
        ? 'strong'
        : 'adequate'
      : version.state === 'proposed'
        ? 'weak'
        : 'missing';
  if (version.state === 'rejected' || version.state === 'superseded') {
    findings.push(`This version is ${version.state}, not the one in use.`);
  }
  return { rating, findings };
}

function effectivenessEvidence({ skill }: SkillQualityInput): Rated {
  const { applications, matchedCases, synthetic, precedent } = skill.effectiveness;
  const findings = [
    `${plural(applications, 'application')}; matched ${plural(matchedCases, 'case')}.`,
  ];
  if (synthetic && (applications > 0 || matchedCases > 0)) {
    findings.push(
      'Every contributing case is synthetic: the figures show the pipeline works, not that the skill helps.',
    );
  }
  const rating: SkillQualityRating =
    applications >= 5 && !synthetic && precedent !== undefined
      ? 'strong'
      : applications >= 2
        ? 'adequate'
        : applications >= 1 || matchedCases >= 1
          ? 'weak'
          : 'missing';
  return { rating, findings };
}

const RATERS: Readonly<Record<SkillQualityDimension, (input: SkillQualityInput) => Rated>> = {
  specificity,
  evidence_basis: evidenceBasis,
  trigger_conditions: triggerConditions,
  required_context: requiredContext,
  prohibited_context: prohibitedContext,
  false_positive_risk: falsePositiveRisk,
  transferability,
  expected_action: expectedAction,
  outcome_evidence: outcomeEvidence,
  governance_status: governanceStatus,
  version: versionRating,
  effectiveness_evidence: effectivenessEvidence,
};

// ---------------------------------------------------------------- what to prevent

/** What kind of case-specific data a piece of text holds. The value itself is never copied into a message. */
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
/** Addresses that name no customer: the documentation ranges (RFC 5737), loopback, and the best-known public resolvers. */
const NOT_A_CUSTOMER_ADDRESS =
  /^(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|127\.|0\.0\.0\.0$|1\.1\.1\.1$|1\.0\.0\.1$|8\.8\.8\.8$|8\.8\.4\.4$|9\.9\.9\.9$)/;
/** An address that follows one of these words on its line is an example, as in a template's `# e.g. "10.0.0.10"`. */
const EXAMPLE_MARKER = /(?:\be\.g\.|\b(?:eg|for example|for instance|example|such as)\b)/i;

/** Whether `text` holds an IP address that could be a customer's (not an example, a documentation range or a public resolver). */
function hasCustomerAddress(text: string): boolean {
  for (const found of text.matchAll(IPV4)) {
    const at = found.index ?? 0;
    if (NOT_A_CUSTOMER_ADDRESS.test(found[0])) continue;
    const lineStart = text.lastIndexOf('\n', at) + 1;
    if (EXAMPLE_MARKER.test(text.slice(lineStart, at))) continue;
    return true;
  }
  return false;
}

const CASE_DATA: readonly { kind: string; holds: (text: string) => boolean }[] = [
  { kind: 'an IP address', holds: hasCustomerAddress },
  { kind: 'an e-mail address', holds: (text) => /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text) },
  {
    kind: 'an identifier (GUID)',
    holds: (text) => /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text),
  },
  { kind: 'a token', holds: (text) => /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/.test(text) },
  {
    kind: 'a secret or password',
    holds: (text) =>
      /\b(?:password|passwd|pwd|secret|api[_-]?key|client[_-]?secret|token)\s*[:=]\s*(?!\{\{)\S{6,}/i.test(
        text,
      ),
  },
  { kind: 'a long hexadecimal value', holds: (text) => /\b[0-9a-f]{32,}\b/i.test(text) },
];

/** Every piece of text of a skill that a person or a query would read, with where it is. */
function textsOf(content: Content): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [
    { where: 'the name', text: content.name },
    { where: 'the description', text: content.description },
  ];
  content.triggerConditions.forEach((c, i) => {
    out.push({ where: `trigger ${i + 1}`, text: `${c.description} ${c.pattern ?? ''}` });
  });
  content.exclusions.forEach((c, i) =>
    out.push({ where: `exclusion ${i + 1}`, text: `${c.description} ${c.pattern ?? ''}` }),
  );
  content.decisionSequence.forEach((s) => {
    out.push({ where: `step ${s.order}`, text: `${s.title} ${s.instruction}` });
    s.branches.forEach((b) =>
      out.push({ where: `step ${s.order}, a branch`, text: `${b.condition} ${b.rationale}` }),
    );
  });
  content.queryTemplates.forEach((q) =>
    out.push({ where: `the query “${q.title}”`, text: `${q.description} ${q.template}` }),
  );
  content.candidateActions.forEach((a) =>
    out.push({ where: `the action “${a.label}”`, text: a.whenToUse }),
  );
  const lists: [string, readonly string[]][] = [
    ['a stop condition', content.stopConditions],
    ['a success condition', content.successConditions],
    ['an escalation condition', content.escalationConditions],
    ['a safety constraint', content.safetyConstraints],
    ['a known failure mode', content.knownFailureModes],
    ['a limitation', content.applicability?.limitations ?? []],
  ];
  for (const [where, items] of lists) for (const text of items) out.push({ where, text });
  if (content.applicability) out.push({ where: 'the scope', text: content.applicability.scope });
  return out;
}

function caseSpecificData(content: Content): SkillQualityIssue[] {
  const found = new Map<string, Set<string>>();
  for (const { where, text } of textsOf(content)) {
    for (const { kind, holds } of CASE_DATA) {
      if (!holds(text)) continue;
      const places = found.get(kind) ?? new Set<string>();
      places.add(where);
      found.set(kind, places);
    }
  }
  return [...found].map(([kind, places]) => ({
    kind: 'case_specific_data' as const,
    severity: 'blocking' as const,
    message: `It contains ${kind} (in ${[...places].slice(0, 3).join(', ')}${places.size > 3 ? ' and more' : ''}); a reusable skill describes a situation, not one customer's data.`,
  }));
}

const HINDSIGHT_TRIGGER = /^triggerConditions\.(.+)$/;

function unsupportedCausalClaims(input: SkillQualityInput): SkillQualityIssue[] {
  const { content } = input.version;
  const issues: SkillQualityIssue[] = [];
  const provenance = content.provenance;
  if (provenance?.hindsight.used === true) {
    if (
      provenance.hindsight.parts.length === 0 ||
      provenance.hindsight.notice.trim().length === 0
    ) {
      issues.push({
        kind: 'unsupported_causal_claim',
        severity: 'blocking',
        message:
          'It was learned with knowledge of the recorded cause but does not say which parts, so a reader cannot tell what was known at the time.',
      });
    }
    const hindsightIds = new Set(
      provenance.hindsight.parts.flatMap((part) => HINDSIGHT_TRIGGER.exec(part)?.[1] ?? []),
    );
    const requiredFromHindsight = content.triggerConditions.filter(
      (c) =>
        c.required && (hindsightIds.has(c.id) || /\(hindsight-informed\)/i.test(c.description)),
    );
    if (requiredFromHindsight.length > 0) {
      issues.push({
        kind: 'unsupported_causal_claim',
        severity: 'warning',
        message: `${plural(requiredFromHindsight.length, 'required trigger')} was learned from the recorded cause, so the skill may only match once the cause is already known.`,
      });
    }
  }
  const onlyHindsight = content.decisionSequence
    .flatMap((step) => step.branches)
    .filter((b) => b.hindsightProbability !== undefined && b.probability === undefined);
  if (onlyHindsight.length > 0) {
    issues.push({
      kind: 'unsupported_causal_claim',
      severity: 'warning',
      message: `${plural(onlyHindsight.length, 'branch', 'branches')} ${onlyHindsight.length === 1 ? 'carries' : 'carry'} only a probability given the recorded cause, with no estimate from what was known at the decision.`,
    });
  }
  const causal = [content.description, ...content.knownFailureModes].some((text) =>
    CAUSAL_LANGUAGE.test(text),
  );
  if (causal && content.sourceCases.length < 2) {
    issues.push({
      kind: 'unsupported_causal_claim',
      severity: 'warning',
      message: 'It states a cause as general, but it rests on a single case.',
    });
  }
  return issues;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let both = 0;
  for (const item of a) if (b.has(item)) both += 1;
  return both / (a.size + b.size - both);
}

function againstLibrary(input: SkillQualityInput): SkillQualityIssue[] {
  const { skill, version, library } = input;
  const mine = new Set(signalIds(version.content));
  const myFirst = firstActionKey(version.content);
  const issues: SkillQualityIssue[] = [];
  for (const other of library) {
    if (other.skill.id === skill.id) continue;
    if (other.skill.tenantId !== skill.tenantId || other.skill.workload !== skill.workload)
      continue;
    if (other.skill.lifecycle === 'retired' || other.skill.lifecycle === 'deprecated') continue;
    const theirs = new Set(signalIds(other.content));
    if (jaccard(mine, theirs) < SAME_SITUATION_SIMILARITY) continue;
    const theirFirst = firstActionKey(other.content);
    if (myFirst === theirFirst) {
      issues.push({
        kind: 'duplicate',
        severity:
          mine.size === theirs.size && [...mine].every((id) => theirs.has(id))
            ? 'blocking'
            : 'warning',
        message: `It describes the same situation as “${other.skill.name}” and recommends the same first step.`,
        relatedSkillId: other.skill.id,
      });
    } else {
      issues.push({
        kind: 'contradictory',
        severity: 'warning',
        message: `“${other.skill.name}” recognises the same situation but recommends a different first step; a reviewer should decide which one stands.`,
        relatedSkillId: other.skill.id,
      });
    }
  }
  return issues;
}

function staleness(input: SkillQualityInput): SkillQualityIssue[] {
  const { skill, now } = input;
  if (LIFECYCLE_RANK[skill.lifecycle] < 4 || skill.lifecycle === 'deprecated') return [];
  if (skill.lastValidatedAt === null) {
    return [
      {
        kind: 'stale',
        severity: 'warning',
        message: 'It is in use but has no validation date.',
      },
    ];
  }
  const days = (Date.parse(now) - Date.parse(skill.lastValidatedAt)) / 86_400_000;
  return days > STALE_AFTER_DAYS
    ? [
        {
          kind: 'stale',
          severity: 'warning',
          message: `It was last validated ${Math.floor(days)} days ago (the limit is ${STALE_AFTER_DAYS}).`,
        },
      ]
    : [];
}

function tooGeneric(input: SkillQualityInput): SkillQualityIssue[] {
  const { content } = input.version;
  const telling = signalIds(content).filter((id) => discriminates(input.pack, id));
  if (telling.length === 0 && !content.triggerConditions.some((c) => c.required)) {
    return [
      {
        kind: 'too_generic',
        severity: 'blocking',
        message:
          'Nothing in it is required and no trigger tells one cause from another, so it would match almost any case.',
      },
    ];
  }
  if (telling.length < 2 && GENERIC_NAME.test(content.name)) {
    return [
      {
        kind: 'too_generic',
        severity: 'warning',
        message: 'Its name reads like a general guide and only one trigger tells causes apart.',
      },
    ];
  }
  return [];
}

function crossTenant(input: SkillQualityInput): SkillQualityIssue[] {
  return input.skill.tenantId === input.tenantId
    ? []
    : [
        {
          kind: 'cross_tenant',
          severity: 'blocking',
          message: 'It belongs to another organisation and must not be used here.',
        },
      ];
}

/** Rates a skill on the twelve dimensions and flags what a reusable skill must not do. */
export function assessSkillQuality(input: SkillQualityInput): SkillQualityAssessment {
  const dimensions = SKILL_QUALITY_DIMENSIONS.map((id) => {
    const { rating, findings } = RATERS[id](input);
    return {
      id,
      label: SKILL_QUALITY_DIMENSION_LABELS[id],
      rating,
      findings: findings.slice(0, 8),
    };
  });
  const issues = [
    ...crossTenant(input),
    ...caseSpecificData(input.version.content),
    ...tooGeneric(input),
    ...unsupportedCausalClaims(input),
    ...againstLibrary(input),
    ...staleness(input),
  ].slice(0, 40);

  const blocking = issues.filter((issue) => issue.severity === 'blocking').length;
  const missing = dimensions.filter((d) => d.rating === 'missing').length;
  const weak = dimensions.filter((d) => d.rating === 'weak').length;
  const warnings = issues.length - blocking;
  const verdict: SkillQualityAssessment['verdict'] =
    blocking > 0 ? 'blocked' : missing > 0 || weak >= 3 || warnings > 0 ? 'needs_work' : 'ready';
  const parts: string[] = [];
  if (blocking > 0) parts.push(plural(blocking, 'blocking issue'));
  if (warnings > 0) parts.push(plural(warnings, 'warning'));
  if (missing > 0) parts.push(`${missing} missing`);
  if (weak > 0) parts.push(`${weak} weak`);
  return {
    skillId: input.skill.id,
    versionId: input.version.id,
    assessedAt: input.now,
    dimensions,
    issues,
    verdict,
    summary:
      verdict === 'ready'
        ? 'Nothing stands in the way of reusing it.'
        : `${verdict === 'blocked' ? 'Do not suggest it yet' : 'Needs work before it is relied on'}: ${parts.join(', ')}.`,
  };
}

// ---------------------------------------------------------------- can it be used here

export interface SkillUseInput {
  /** What matching found for this case. */
  readonly match: Pick<
    SkillMatch,
    'applicability' | 'exclusionsHit' | 'unmatchedTriggers' | 'recommendedSteps' | 'lifecycle'
  >;
  readonly content: SkillContent;
  readonly pack: CompiledPack;
  /** The risk at or above which a step is never suggested. */
  readonly riskCeiling: number;
}

const SUGGESTABLE_LIFECYCLES: ReadonlySet<SkillDna['lifecycle']> = new Set([
  'pilot',
  'validated',
  'published',
]);

/**
 * Whether a matched skill can be used on this case, in the order the rules are checked: it does not apply (an exclusion holds
 * or a required trigger does not); it would be unsafe (its next step is destructive or at the risk ceiling); it needs approval
 * (its next step does, or the skill has not passed the gates that allow it to be suggested); it applies in part; it applies.
 */
export function assessSkillUse(input: SkillUseInput): SkillUseAssessment {
  const { match, content, pack, riskCeiling } = input;
  const unmetRequired = content.triggerConditions.filter(
    (c) => c.required && match.unmatchedTriggers.some((u) => u.id === c.id),
  );
  if (
    match.applicability === 'not_applicable' ||
    match.exclusionsHit.length > 0 ||
    unmetRequired.length > 0
  ) {
    const why =
      match.exclusionsHit.length > 0
        ? `A situation where it must not be used holds: ${match.exclusionsHit[0]?.description ?? 'an exclusion'}.`
        : unmetRequired.length > 0
          ? `A required trigger does not hold: ${unmetRequired[0]?.description ?? 'a trigger'}.`
          : 'It matched too little of the case to apply.';
    return { verdict: 'does_not_apply', reasons: [why] };
  }

  const next =
    match.recommendedSteps.find((step) => step.status === 'recommended_next') ??
    match.recommendedSteps.find((step) => step.status === 'pending');
  const nextKey = next?.actionKey ?? null;
  const action = nextKey !== null ? pack.actions.get(nextKey) : undefined;
  const candidate =
    nextKey !== null ? content.candidateActions.find((c) => c.actionKey === nextKey) : undefined;

  if (action !== undefined && (action.destructive || action.operationalRisk >= riskCeiling)) {
    return {
      verdict: 'unsafe_to_apply',
      reasons: [
        action.destructive
          ? `Its next step, “${action.label}”, changes or removes something.`
          : `Its next step, “${action.label}”, is at or above the risk ceiling.`,
      ],
    };
  }
  if (candidate !== undefined && candidate.risk === 'high' && !candidate.requiresApproval) {
    return {
      verdict: 'unsafe_to_apply',
      reasons: [
        `Its next step, “${candidate.label}”, is high risk and the skill does not ask for approval.`,
      ],
    };
  }
  const reasons: string[] = [];
  if (candidate?.requiresApproval === true || action?.requiresApproval === true) {
    reasons.push(
      `Its next step, “${candidate?.label ?? action?.label ?? 'the next step'}”, needs approval before it is run.`,
    );
  }
  if (!SUGGESTABLE_LIFECYCLES.has(match.lifecycle)) {
    reasons.push('The skill has not yet passed the gates that allow it to be suggested.');
  }
  if (reasons.length > 0) return { verdict: 'requires_approval', reasons };
  if (match.applicability === 'partial') {
    return {
      verdict: 'partially_applies',
      reasons: ['Some of its triggers hold and others do not.'],
    };
  }
  return {
    verdict: 'applies',
    reasons: ['Its triggers hold and its next step is safe to suggest.'],
  };
}
