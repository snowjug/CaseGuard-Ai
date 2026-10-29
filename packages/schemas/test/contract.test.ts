import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_PREFIX,
  CASE_BUNDLE_SCHEMA_VERSION,
  CaseBundleSchema,
  DEFAULT_ACTION_VALUE_CONFIG,
  DEFAULT_EXPORT_CONTROLS,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_QUALITY_CONFIG,
  DEFAULT_REDACTION_CONFIG,
  DEFAULT_RETENTION_CONFIG,
  ActionValueConfigSchema,
  ExportControlsSchema,
  FeatureFlagsSchema,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  ModelConfigSchema,
  PERMISSIONS,
  QualityConfigSchema,
  RedactionConfigSchema,
  RetentionConfigSchema,
  ROUTES,
  buildPath,
  buildQueryString,
  caseBundleJsonSchema,
  knowledgePackJsonSchema,
  validateKnowledgePackReferences,
  type KnowledgePack,
  QUALITY_DIMENSIONS,
  DEFAULT_QUALITY_WEIGHTS,
  PENALTY_KEYS,
  DEFAULT_PENALTY_POINTS,
} from '../src';

const minimalBundle = {
  schemaVersion: CASE_BUNDLE_SCHEMA_VERSION,
  synthetic: true,
  case: {
    reference: 'CG-TEST-0001',
    title: 'Synthetic test case',
    product: 'Test product',
    workload: 'teams-authentication',
    severity: 'B',
    status: 'open',
    openedAt: '2026-03-09T09:00:00Z',
    customerAlias: 'Contoso Synthetic',
  },
  participants: [
    { id: 'p1', role: 'customer_admin', alias: 'Customer Admin 1' },
    { id: 'p2', role: 'support_engineer', alias: 'Support Engineer 1' },
  ],
  events: [
    {
      id: 'e1',
      timestamp: '2026-03-09T09:12:00Z',
      participantId: 'p1',
      type: 'customer_email',
      body: 'Hello',
    },
    {
      id: 'e2',
      timestamp: '2026-03-09T09:30:00Z',
      participantId: 'p2',
      type: 'case_note',
      body: 'Triage',
      inResponseTo: 'e1',
    },
  ],
};

describe('case bundle schema [FR-ING-02]', () => {
  it('accepts a minimal valid bundle and applies defaults', () => {
    const parsed = CaseBundleSchema.parse(minimalBundle);
    expect(parsed.events[0]?.correlationIds).toEqual([]);
    expect(parsed.case.tags).toEqual([]);
  });

  it('rejects duplicate event ids, unknown participants and dangling references with field paths', () => {
    const bad = structuredClone(minimalBundle);
    bad.events.push({
      id: 'e1',
      timestamp: '2026-03-09T10:00:00Z',
      participantId: 'ghost',
      type: 'case_note',
      body: 'x',
    });
    (bad.events[1] as Record<string, unknown>).inResponseTo = 'nope';
    const result = CaseBundleSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((i) => i.message).join(' | ') ?? '';
    expect(messages).toContain('Duplicate event id "e1"');
    expect(messages).toContain('Unknown participant "ghost"');
    expect(messages).toContain('inResponseTo references unknown event "nope"');
  });

  it('rejects non-UTC or malformed timestamps', () => {
    const bad = structuredClone(minimalBundle);
    (bad.events[0] as Record<string, unknown>).timestamp = '2026-03-09 09:12';
    expect(CaseBundleSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects events earlier than the case open time', () => {
    const bad = structuredClone(minimalBundle);
    (bad.events[0] as Record<string, unknown>).timestamp = '2026-03-09T08:00:00Z';
    expect(CaseBundleSchema.safeParse(bad).success).toBe(false);
  });
});

describe('route registry integrity [FR-UX-04 / NFR-SEC-02]', () => {
  const entries = Object.entries(ROUTES);

  it('has unique method+path pairs', () => {
    const seen = new Set<string>();
    for (const [id, route] of entries) {
      const key = `${route.method} ${route.path}`;
      expect(seen.has(key), `duplicate route ${key} (${id})`).toBe(false);
      seen.add(key);
    }
  });

  it('prefixes every path with the API version and uses valid permissions', () => {
    for (const [id, route] of entries) {
      expect(route.path.startsWith(API_PREFIX), id).toBe(true);
      if (route.permission !== null) expect(PERMISSIONS, id).toContain(route.permission);
    }
  });

  it('declares a params schema covering every :param segment', () => {
    for (const [id, route] of entries) {
      const names = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      if (names.length === 0) continue;
      const params = (route as { params?: z.ZodObject<z.ZodRawShape> }).params;
      expect(params, `${id} needs params`).toBeDefined();
      const keys = Object.keys(params?.shape ?? {});
      for (const name of names) expect(keys, `${id} param ${name}`).toContain(name);
    }
  });

  // Lists that are bounded by construction rather than by a `limit` parameter:
  // events per case are capped at 2000 by the bundle schema, hypotheses by the knowledge pack,
  // forks/counterfactuals/warnings/matches by engine caps (see docs/DATA_MODEL.md).
  const BOUNDED_BY_DESIGN = new Set([
    'samples.list',
    'examples.list',
    'actions.list',
    'hypotheses.list',
    'skillMatches.list',
    'warnings.list',
    'counterfactuals.list',
    'forks.list',
  ]);

  it('never exposes unbounded list endpoints: list responses are paginated or capped', () => {
    for (const [id, route] of entries) {
      if (id.endsWith('.list') && route.method === 'GET') {
        const query = (route as { query?: z.ZodType }).query;
        const shape = query instanceof z.ZodObject ? Object.keys(query.shape) : [];
        const bounded = shape.includes('limit') || BOUNDED_BY_DESIGN.has(id);
        expect(bounded, `${id} must paginate or be naturally bounded`).toBe(true);
      }
    }
  });

  it('builds paths and query strings safely', () => {
    expect(buildPath(ROUTES['cases.get'].path, { caseId: 'case_a/b' })).toBe(
      '/api/v1/cases/case_a%2Fb',
    );
    expect(() => buildPath(ROUTES['cases.get'].path, {})).toThrow(/Missing path parameter/);
    expect(buildQueryString({ a: 1, b: undefined, c: '', d: 'x y' })).toBe('?a=1&d=x+y');
    expect(buildQueryString({})).toBe('');
  });
});

describe('default configuration parses against its schema [FR-GV-02]', () => {
  it('validates every governed default', () => {
    expect(() => ModelConfigSchema.parse(DEFAULT_MODEL_CONFIG)).not.toThrow();
    expect(() => QualityConfigSchema.parse(DEFAULT_QUALITY_CONFIG)).not.toThrow();
    expect(() => ActionValueConfigSchema.parse(DEFAULT_ACTION_VALUE_CONFIG)).not.toThrow();
    expect(() => RetentionConfigSchema.parse(DEFAULT_RETENTION_CONFIG)).not.toThrow();
    expect(() => RedactionConfigSchema.parse(DEFAULT_REDACTION_CONFIG)).not.toThrow();
    expect(() => ExportControlsSchema.parse(DEFAULT_EXPORT_CONTROLS)).not.toThrow();
    expect(() => FeatureFlagsSchema.parse(DEFAULT_FEATURE_FLAGS)).not.toThrow();
  });

  it('keeps the specified quality weights summing to 100 percent [FR-QI-01]', () => {
    const sum = QUALITY_DIMENSIONS.reduce((s, k) => s + DEFAULT_QUALITY_WEIGHTS[k], 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(DEFAULT_QUALITY_WEIGHTS).toMatchObject({
      evidence_integrity: 0.25,
      diagnostic_reasoning: 0.2,
      scoping_completeness: 0.15,
      customer_communication: 0.15,
      resolution_validation: 0.15,
      efficiency_proportionality: 0.1,
    });
    expect(PENALTY_KEYS).toHaveLength(10);
    for (const key of PENALTY_KEYS) expect(DEFAULT_PENALTY_POINTS[key]).toBeGreaterThan(0);
  });

  it('keeps action-value cost weights summing to 1 so the denominator stays interpretable [FR-AV-01]', () => {
    const w = DEFAULT_ACTION_VALUE_CONFIG.weights;
    expect(w.time + w.token + w.customer + w.risk).toBeCloseTo(1, 10);
  });

  it('defines every metric with an explanation [FR-UX-07]', () => {
    for (const key of METRIC_KEYS) {
      const def = METRIC_DEFINITIONS[key];
      expect(def.definition.length).toBeGreaterThan(40);
      expect(def.formula.length).toBeGreaterThan(5);
      expect(def.estimated).toBe(true);
    }
  });
});

describe('JSON schema export [FR-ING-09]', () => {
  it('exports a draft 2020-12 schema for case bundles with the version constant', () => {
    const schema = caseBundleJsonSchema();
    expect(schema.$schema).toContain('2020-12');
    expect(JSON.stringify(schema)).toContain(CASE_BUNDLE_SCHEMA_VERSION);
  });

  it('exports a schema for knowledge packs', () => {
    const schema = knowledgePackJsonSchema();
    expect(schema.title).toBe('CaseGuard workload knowledge pack');
  });
});

describe('knowledge pack reference validation', () => {
  const tiny = (): KnowledgePack => ({
    id: 'kp.tiny',
    version: '1.0.0',
    workload: 'tiny',
    title: 'Tiny pack',
    description: 'test',
    disclaimer: 'Illustrative synthetic knowledge pack used for tests only.',
    hypotheses: [
      {
        id: 'hyp.a',
        name: 'Hypothesis A',
        description: 'a',
        category: 'network',
        prior: 0.6,
        assumptions: [],
        keywords: [],
        validatingActionIds: ['act.x'],
        confirmationRequirementIds: [],
      },
      {
        id: 'hyp.other',
        name: 'Other',
        description: 'o',
        category: 'unknown',
        prior: 0.4,
        assumptions: [],
        keywords: [],
        validatingActionIds: [],
        confirmationRequirementIds: [],
      },
    ],
    signals: [
      {
        id: 'sig.s',
        label: 'Signal S',
        description: 'd',
        detectors: [{ kind: 'regex', pattern: 'foo', flags: 'i' }],
        strength: 'strong',
        evidenceKind: 'presence',
        category: 'diagnostic_evidence',
        likelihoods: { 'hyp.a': 0.9 },
        neutral: 0.5,
        explanation: 'e',
        satisfies: [],
      },
    ],
    actions: [
      {
        id: 'act.x',
        label: 'Action X',
        description: 'd',
        kind: 'log_query',
        executor: 'engineer',
        valueClass: 'diagnostic',
        timeMinutes: { min: 1, typical: 2, max: 3 },
        tokenEstimate: 10,
        computeUnits: 1,
        customerEffort: 'none',
        operationalRisk: 0,
        destructive: false,
        requiresApproval: false,
        reliability: 0.9,
        requires: [],
        produces: [],
        targets: ['hyp.a'],
        outcomes: [
          { id: 'o1', label: 'Outcome one', emitsSignals: ['sig.s'], simulatedResult: 'r' },
        ],
        detectors: [],
        templates: {},
      },
    ],
    requirements: [],
    claimPatterns: [],
    inferences: [],
    lexicon: {
      hedges: [],
      definitive: [],
      customerReport: [],
      template: [],
      workaround: [],
      permanentFix: [],
      validation: [],
      nextSteps: [],
      expectation: [],
      closure: [],
      injection: [],
    },
    policies: {
      diagnosisThreshold: 0.75,
      minimumEvidenceForEscalation: [],
      escalationActionIds: [],
      destructiveHypothesisThreshold: 0.6,
      lowValueRelativeScore: 0.35,
      lowValueInformationGainBits: 0.08,
      repeatWindowMinutes: 1440,
      customerResponsePriorMinutes: { min: 45, typical: 90, max: 180 },
      maxCounterfactualSteps: 8,
      rolloutCount: 200,
      posteriorFloor: 0.01,
      strengthWeights: { strong: 1, moderate: 0.75, weak: 0.5 },
      forkMinimumImpact: 0.25,
    },
  });

  it('accepts a sound pack', () => {
    expect(validateKnowledgePackReferences(tiny())).toEqual([]);
  });

  it('reports bad priors, dangling references and non-monotonic times', () => {
    const pack = tiny();
    pack.hypotheses[0]!.prior = 0.7;
    pack.signals[0]!.likelihoods['hyp.ghost'] = 0.5;
    pack.actions[0]!.requires = ['req.ghost'];
    pack.actions[0]!.timeMinutes = { min: 5, typical: 2, max: 3 };
    const problems = validateKnowledgePackReferences(pack).join('\n');
    expect(problems).toContain('priors sum');
    expect(problems).toContain('unknown hypothesis hyp.ghost');
    expect(problems).toContain('unknown requirement req.ghost');
    expect(problems).toContain('non-monotonic');
  });

  it('requires the catch-all hypothesis', () => {
    const pack = tiny();
    pack.hypotheses = pack.hypotheses.filter((h) => h.id !== 'hyp.other');
    pack.hypotheses[0]!.prior = 1;
    expect(validateKnowledgePackReferences(pack).join('\n')).toContain('catch-all');
  });
});
