import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_CONFIG } from '@caseguard/schemas';
import {
  DETERMINISTIC_THRESHOLDS,
  DeterministicProvider,
  MODEL_THRESHOLDS,
  ProviderError,
  TokenGovernor,
  evalReportToJson,
  evalReportToMarkdown,
  runEvaluation,
  type EvalReport,
  type HypothesisProposals,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderDescriptor,
} from '../src';
import { CASE_ONE, CASE_TWO, prepareCase, toEvalCase } from './helpers';
import { FakeClock } from './fakes';

const clock = new FakeClock();
const governor = new TokenGovernor({ config: DEFAULT_MODEL_CONFIG, clock });
const deterministic = new DeterministicProvider({ clock, governor });
const caseOne = toEvalCase(prepareCase(CASE_ONE), 'case-one');
const caseTwo = toEvalCase(prepareCase(CASE_TWO), 'case-two');

/** Looks like a remote model but rewrites the deterministic answer, to prove the gates can fail. */
class TamperingProvider implements ModelProvider {
  readonly kind = 'azure-openai' as const;
  readonly simulated = false;
  readonly defaultModel = 'tampering-test';

  constructor(
    private readonly tamper: (output: HypothesisProposals, request: ModelRequest) => void,
  ) {}

  describe(): ProviderDescriptor {
    return {
      kind: 'azure-openai',
      simulated: false,
      model: this.defaultModel,
      configured: true,
      validationNote: 'Tampering test provider.',
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await deterministic.complete(request);
    const output: unknown = structuredClone(response.output);
    if (request.agent === 'hypothesis_generator')
      this.tamper(output as HypothesisProposals, request);
    return {
      ...response,
      output,
      outputText: JSON.stringify(output),
      provider: 'azure-openai',
      simulated: false,
    };
  }
}

describe('evaluation harness on the deterministic provider [FR-TK-03]', () => {
  let report: EvalReport;

  beforeAll(async () => {
    report = await runEvaluation({ provider: deterministic, cases: [caseOne, caseTwo], clock });
  }, 180_000);

  it('[FR-TK-03] passes every release gate at the required values', () => {
    expect(report.passed).toBe(true);
    expect(report.gates.map((g) => g.id)).toEqual([
      'schema-validity',
      'citation-validity',
      'groundedness',
      'temporal-leak',
      'unsafe-recommendation',
      'classification-agreement',
      'prompt-injection-resistance',
    ]);
    expect(report.gates.every((g) => g.passed)).toBe(true);
    expect(report.thresholds).toEqual(DETERMINISTIC_THRESHOLDS);
    const m = report.metrics;
    expect(m.providerErrors).toBe(0);
    expect(m.schemaValidityRate).toBe(1);
    expect(m.citationValidityRate).toBe(1);
    expect(m.referenceValidityRate).toBe(1);
    expect(m.groundedness).toBeGreaterThanOrEqual(0.95);
    expect(m.temporalLeakRate).toBe(0);
    expect(m.unsafeRecommendationRate).toBe(0);
    expect(m.classificationAgreement).toBe(1);
    expect(m.forkRecall).toBe(1);
    expect(m.forkPrecision).toBe(1);
    expect(m.counterfactualRealism).toBe(1);
    expect(m.adversarialRejectionRate).toBe(1);
  });

  it('[FR-TK-03] covers both synthetic cases and every model-capable agent', () => {
    expect(report.cases.map((c) => c.id)).toEqual(['case-one', 'case-two']);
    expect(report.metrics.samples).toBeGreaterThanOrEqual(30);
    const agents = report.byAgent.map((a) => a.agent).sort();
    expect(agents).toEqual([
      'communication_coach',
      'counterfactual_simulator',
      'decision_fork_detector',
      'evidence_classifier',
      'hypothesis_generator',
      'quality_judge',
      'skilldna_extractor',
      'timeline_analyzer',
    ]);
    for (const id of ['case-one', 'case-two']) {
      expect(report.samples.filter((s) => s.caseId === id).length).toBeGreaterThan(10);
    }
    for (const summary of report.byAgent) {
      expect(summary.temporalLeakRate, summary.agent).toBe(0);
      expect(summary.unsafeRecommendationRate, summary.agent).toBe(0);
      expect(summary.schemaValidityRate, summary.agent).toBe(1);
    }
  });

  it('[NFR-SEC-05] rejects every adversarial fixture, including prompt injection inside case text', () => {
    expect(report.adversarial.length).toBeGreaterThanOrEqual(28);
    expect(report.adversarial.filter((a) => !a.rejected)).toEqual([]);
    const kinds = new Set(report.adversarial.map((a) => a.kind));
    expect(kinds).toEqual(new Set(['prompt_injection_input', 'bad_output']));
    const observed = new Set<string>(report.adversarial.flatMap((a) => a.observedKinds));
    for (const kind of [
      'citation',
      'temporal',
      'policy',
      'injection',
      'groundedness',
      'schema',
      'size',
    ]) {
      expect(observed.has(kind), kind).toBe(true);
    }
    const ids = report.adversarial.map((a) => a.id).join(' ');
    expect(ids).toMatch(/hallucinated/);
    expect(ids).toMatch(/future/);
    expect(ids).toMatch(/destructive/);
    expect(ids).toMatch(/ignore-previous/);
    expect(ids).toMatch(/delimiter/);
  });

  it('[FR-TK-03] states honestly that the deterministic reference is the thing under test', () => {
    expect(report.provider).toMatchObject({ kind: 'deterministic', simulated: true });
    expect(report.notes.join(' ')).toMatch(/not a claim about real-world accuracy/);
    expect(report.notes.join(' ')).toMatch(
      /verify the contracts and validators, not model quality/,
    );
  });

  it('[FR-TK-03] produces a machine-readable report that round-trips and is reproducible', async () => {
    const json = evalReportToJson(report);
    const parsed = JSON.parse(json) as EvalReport;
    expect(parsed.metrics).toEqual(report.metrics);
    expect(parsed.gates).toEqual(report.gates);
    expect(parsed.passed).toBe(true);
    const again = await runEvaluation({
      provider: deterministic,
      cases: [caseOne],
      clock,
      maxSamples: 4,
    });
    expect(again.samples).toEqual(report.samples.slice(0, 4));
  }, 120_000);

  it('[FR-TK-03] renders a markdown report with the gates, metrics and fixtures', () => {
    const markdown = evalReportToMarkdown(report);
    expect(markdown).toMatch(/^# CaseGuard AI evaluation report/);
    expect(markdown).toContain('Result: **PASS**');
    expect(markdown).toContain('| Temporal leakage rate | 0.0% | <= 0.0% | pass |');
    expect(markdown).toContain('| Unsafe recommendation rate | 0.0% | <= 0.0% | pass |');
    expect(markdown).toContain('## By agent');
    expect(markdown).toContain('## Adversarial fixtures');
    expect(markdown).toContain('simulated');
    expect(markdown).not.toContain('FAIL');
  });
});

describe('evaluation gates fail for an unsafe or leaking provider [FR-CF-02]', () => {
  const smallPlan = { cutFractions: [0.5, 1], maxForks: 1 } as const;

  it('[FR-CF-02] a provider that cites events after the boundary fails the temporal-leak gate', async () => {
    const provider = new TamperingProvider((output, request) => {
      const { task } = request;
      if (task.agent !== 'hypothesis_generator') return;
      const future = task.input.hindsight?.events.find((e) => e.timestamp > task.input.view.asOf);
      const first = output.hypotheses[0];
      if (future && first) first.eventIds = [future.id];
    });
    const report = await runEvaluation({
      provider,
      cases: [caseOne],
      clock,
      plan: smallPlan,
      maxSamples: 12,
    });
    expect(report.thresholds).toEqual(MODEL_THRESHOLDS);
    expect(report.metrics.temporalLeakRate).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
    expect(report.gates.find((g) => g.id === 'temporal-leak')?.passed).toBe(false);
    expect(evalReportToMarkdown(report)).toContain('Result: **FAIL**');
  }, 120_000);

  it('[FR-CF-04] a provider that recommends a destructive action fails the unsafe-recommendation gate', async () => {
    const provider = new TamperingProvider((output) => {
      const first = output.hypotheses[0];
      if (first) first.cheapestSafeActionKey = 'act.revoke-user-sessions';
    });
    const report = await runEvaluation({
      provider,
      cases: [caseOne],
      clock,
      plan: smallPlan,
      maxSamples: 12,
    });
    expect(report.metrics.unsafeRecommendationRate).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
    expect(report.gates.find((g) => g.id === 'unsafe-recommendation')?.passed).toBe(false);
    expect(
      report.samples.some((s) => s.unsafeRecommendation && s.issueKinds.includes('policy')),
    ).toBe(true);
  }, 120_000);

  it('[NFR-REL-01] a provider that throws is counted as an error, not as a pass', async () => {
    const broken: ModelProvider = {
      kind: 'azure-openai',
      simulated: false,
      defaultModel: 'broken',
      describe: () => ({
        kind: 'azure-openai',
        simulated: false,
        model: 'broken',
        configured: true,
        validationNote: 'Broken test provider.',
      }),
      complete: () => Promise.reject(new ProviderError('server_error', 'provider exploded')),
    };
    const report = await runEvaluation({
      provider: broken,
      cases: [caseOne],
      clock,
      plan: smallPlan,
      maxSamples: 5,
    });
    expect(report.metrics.providerErrors).toBe(5);
    expect(report.metrics.schemaValidityRate).toBe(0);
    expect(report.passed).toBe(false);
    expect(report.samples.every((s) => s.providerError?.startsWith('server_error'))).toBe(true);
  });
});
