import type { EvalReport } from './types';

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Machine-readable report (stable key order, safe to archive or diff). */
export function evalReportToJson(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

/** Human-readable report. Honest about what the numbers do and do not show. */
export function evalReportToMarkdown(report: EvalReport): string {
  const m = report.metrics;
  const lines: string[] = [
    '# CaseGuard AI evaluation report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Provider: ${report.provider.kind} (${report.provider.model})${report.provider.simulated ? ' - simulated' : ''}`,
    `- Cases: ${report.cases.map((c) => `${c.id} (${c.events} events)`).join(', ')}`,
    `- Samples: ${m.samples} (provider errors: ${m.providerErrors})`,
    `- Result: **${report.passed ? 'PASS' : 'FAIL'}**`,
    '',
    '## Gates',
    '',
    '| Gate | Value | Threshold | Result |',
    '| --- | --- | --- | --- |',
    ...report.gates.map(
      (g) =>
        `| ${g.label} | ${pct(g.value)} | ${g.comparator} ${pct(g.threshold)} | ${g.passed ? 'pass' : 'FAIL'} |`,
    ),
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| JSON-schema compliance | ${pct(m.schemaValidityRate)} |`,
    `| Samples with fully valid references | ${pct(m.citationValidityRate)} |`,
    `| Valid references / all references | ${pct(m.referenceValidityRate)} |`,
    `| Claim support | ${pct(m.groundedness)} (unsupported claim rate ${pct(m.unsupportedClaimRate)}) |`,
    `| Temporal leakage | ${pct(m.temporalLeakRate)} |`,
    `| Unsafe recommendations | ${pct(m.unsafeRecommendationRate)} |`,
    `| Classification agreement with reference | ${pct(m.classificationAgreement)} |`,
    `| Decision-fork recall / precision | ${pct(m.forkRecall)} / ${pct(m.forkPrecision)} |`,
    `| Counterfactual step safety | ${pct(m.counterfactualRealism)} |`,
    `| SkillDNA proposal completeness | ${pct(m.skillCompleteness)} |`,
    `| Adversarial fixtures rejected | ${pct(m.adversarialRejectionRate)} |`,
    `| Legitimate wording accepted | ${pct(m.legitimateWordingAcceptanceRate)} |`,
    `| Mean latency | ${m.meanLatencyMs.toFixed(1)} ms |`,
    `| Tokens (${report.provider.simulated ? 'estimated' : 'as reported'}) | ${m.totalTokens} |`,
    '',
    '## By agent',
    '',
    '| Agent | Samples | Schema | References | Support | Leakage | Unsafe |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.byAgent.map(
      (a) =>
        `| ${a.agent} | ${a.samples} | ${pct(a.schemaValidityRate)} | ${pct(a.citationValidityRate)} | ${pct(a.groundedness)} | ${pct(a.temporalLeakRate)} | ${pct(a.unsafeRecommendationRate)} |`,
    ),
    '',
    '## Adversarial fixtures',
    '',
    '| Fixture | Kind | Expected | Observed | Rejected |',
    '| --- | --- | --- | --- | --- |',
    ...report.adversarial.map(
      (a) =>
        `| ${a.id} | ${a.kind} | ${a.expectedKinds.join(', ') || '-'} | ${a.observedKinds.join(', ') || '-'} | ${a.rejected ? 'yes' : 'NO'} |`,
    ),
    '',
    '## Legitimate wording that must be accepted',
    '',
    '| Control | Observed | Accepted |',
    '| --- | --- | --- |',
    ...report.controls.map(
      (c) => `| ${c.id} | ${c.observedKinds.join(', ') || '-'} | ${c.accepted ? 'yes' : 'NO'} |`,
    ),
    '',
    '## Notes',
    '',
    ...report.notes.map((n) => `- ${n}`),
    '',
  ];
  return lines.join('\n');
}
