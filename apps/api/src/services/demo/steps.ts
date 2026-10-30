import type { CaseFacts, DemoFacts, StepSpec } from './types';

/** A deep link into the web app. Case ids are encoded; `null` means the case does not exist yet. */
function casePath(caseFacts: CaseFacts | null, section?: string): string {
  if (caseFacts === null) return '/cases/new';
  const base = `/cases/${encodeURIComponent(caseFacts.id)}`;
  return section === undefined ? base : `${base}/${section}`;
}

const skillPath = (facts: DemoFacts): string =>
  facts.skill === null ? '/skills' : `/skills/${encodeURIComponent(facts.skill.id)}`;

/**
 * Where the two cases are compared: the "Compare cases" tab of Case Two's quality review, with Case One chosen as
 * the case to compare with (`?tab=compare&with=`). Until both cases exist, the Efficiency Monitor is the nearest view.
 */
const comparePath = (facts: DemoFacts): string =>
  facts.caseOne !== null && facts.caseTwo !== null
    ? `${casePath(facts.caseTwo, 'quality')}?tab=compare&with=${encodeURIComponent(facts.caseOne.id)}`
    : '/efficiency';

const hasMetrics = (c: CaseFacts | null): boolean =>
  c !== null && c.analyzed && c.qualityAssessed && c.metricCount > 0;

/** Case Two has its metrics and the engineer applied the skill's guided plan (conformance is recorded). */
const secondInvestigationDone = (f: DemoFacts): boolean =>
  hasMetrics(f.caseTwo) && f.followUpMatch?.hasConformance === true;

/**
 * The 13 steps of the required end-to-end story, in order. Wording is deliberate: it says what is
 * simulated or estimated, and it never judges a person. `done` reads only stored facts, so the guide
 * can never be moved ahead by a client.
 */
export const STEP_SPECS: readonly StepSpec[] = [
  {
    id: 'import-case-one',
    persona: 'engineer',
    title: 'Import Case One',
    description:
      'Load the synthetic Case One, an intermittent Microsoft Teams sign-in failure, from the built-in samples.',
    presenterNotes:
      'All data is synthetic. Ingestion validates, redacts and screens the payload, then stores an immutable record of exactly what was received. Nothing is analysed yet.',
    actionLabel: 'Load Case One',
    route: (f) => casePath(f.caseOne),
    done: (f) => f.caseOne !== null,
  },
  {
    id: 'reconstruct-timeline',
    persona: 'engineer',
    title: 'Timeline reconstructed',
    description:
      'The analysis rebuilds the investigation as a timeline of events and actions, with what was known at each moment.',
    presenterNotes:
      'The engine reads only the written record. The offline provider is deterministic and simulated, so every result is reproducible and nothing leaves this machine.',
    actionLabel: 'Open the timeline',
    route: (f) => casePath(f.caseOne, 'timeline'),
    done: (f) => f.caseOne?.analyzed === true,
  },
  {
    id: 'build-evidence-ledger',
    persona: 'engineer',
    title: 'Evidence ledger built',
    description:
      'Every statement becomes a claim classified as a confirmed fact, a customer report, an assumption, diagnostic evidence or an inference, and is linked to its source.',
    presenterNotes:
      'Classification uses transparent rules over the case text. A reviewer can correct a category; the original classification is never overwritten.',
    actionLabel: 'Open the evidence ledger',
    route: (f) => casePath(f.caseOne, 'evidence'),
    done: (f) => (f.caseOne?.claimCount ?? 0) > 0,
  },
  {
    id: 'compare-hypotheses',
    persona: 'engineer',
    title: 'Competing hypotheses shown',
    description:
      'Several explanations stay alive together, each with a confidence range that moves as evidence arrives.',
    presenterNotes:
      'Confidence is a model estimate from an authored knowledge pack, never a statistical truth. The range shows how uncertain the estimate is.',
    actionLabel: 'Open the hypothesis arena',
    route: (f) => casePath(f.caseOne, 'hypotheses'),
    done: (f) => (f.caseOne?.hypothesisCount ?? 0) >= 2,
  },
  {
    id: 'find-decision-forks',
    persona: 'engineer',
    title: 'Decision forks found',
    description:
      'CaseGuard marks the moments where the investigation could have taken a safer or shorter path, and highlights the earliest meaningful one.',
    presenterNotes:
      'Forks are detected from what was known at the decision time only. Hindsight is never used to detect them or to generate alternatives.',
    actionLabel: 'Review the decision forks',
    route: (f) => casePath(f.caseOne, 'counterfactual'),
    done: (f) => (f.caseOne?.forkCount ?? 0) >= 1,
  },
  {
    id: 'accept-better-path',
    persona: 'reviewer',
    title: 'A better path simulated and accepted',
    description:
      'A counterfactual path for the earliest meaningful fork is simulated from the information available at that moment, and a reviewer accepts it with a reason.',
    presenterNotes:
      'The path is simulated and estimated, not observed. A leak check shows that nothing later than the decision was used, and only a reviewer-accepted path can seed a skill.',
    actionLabel: 'Review the better path',
    route: (f) => casePath(f.caseOne, 'counterfactual'),
    done: (f) => (f.caseOne?.acceptedScenarioId ?? null) !== null,
  },
  {
    id: 'calculate-metrics',
    persona: 'manager',
    title: 'Quality and efficiency metrics calculated',
    description:
      'Case quality, evidence integrity, avoidable support effort, reasoning efficiency, customer effort, resolution confidence and token efficiency, each with its range.',
    presenterNotes:
      'Every figure is an estimate with a formula and a range, and token counts come from the offline provider, so they are estimates too. None of it rates a person.',
    actionLabel: 'Open the quality review',
    route: (f) => casePath(f.caseOne, 'quality'),
    done: (f) => hasMetrics(f.caseOne),
  },
  {
    id: 'generate-skill',
    persona: 'engineer',
    title: 'Draft SkillDNA generated',
    description:
      'The accepted path is distilled into a reusable investigation skill with triggers, steps, stop conditions and safety constraints.',
    presenterNotes:
      'A new skill starts as Discovered and is never published automatically. Only a path a reviewer accepted can seed it.',
    actionLabel: 'Extract a skill',
    route: (f) => (f.skill === null ? casePath(f.caseOne, 'counterfactual') : skillPath(f)),
    done: (f) => f.skill !== null,
  },
  {
    id: 'approve-skill',
    persona: 'skill_curator',
    title: 'Governed approval completed',
    description:
      'The skill moves through draft, simulation test, expert review, pilot, validation and publication. The pilot approver and the publisher must be different people.',
    presenterNotes:
      'Four-eyes is enforced: creators cannot approve their own skill and the pilot approver cannot publish it. The simulation and regression tests replay recorded cases; they are simulations, not production results.',
    actionLabel: 'Open the skill',
    route: skillPath,
    done: (f) => f.skill?.governedPublication === true,
  },
  {
    id: 'import-case-two',
    persona: 'engineer',
    title: 'Import Case Two',
    description:
      'Load the related but different synthetic Case Two: a Teams sign-in failure with another root cause.',
    presenterNotes:
      'Case Two is a different case with its own cause, so the skill has to earn its match rather than assume it.',
    actionLabel: 'Load Case Two',
    route: (f) => casePath(f.caseTwo),
    done: (f) => f.caseTwo !== null,
  },
  {
    id: 'skill-applies',
    persona: 'engineer',
    title: 'The validated skill applies to Case Two',
    description:
      'CaseGuard matches the published skill to Case Two using only what was known at its first email.',
    presenterNotes:
      'The match is evaluated as of the first email, so it shows what the skill would have suggested before any investigation. The score is an estimate.',
    actionLabel: 'See the skill match',
    route: (f) => casePath(f.caseTwo),
    done: (f) => f.followUpMatch?.applies === true,
  },
  {
    id: 'second-investigation',
    persona: 'engineer',
    title: 'The second investigation is shorter and more evidence-driven',
    description:
      'The guided plan is applied to Case Two, and conformance with it is recorded next to the case metrics.',
    presenterNotes:
      'Conformance is an estimate of how closely the route followed the plan: it describes the route, never the person. A difference between two synthetic cases shows the measurement pipeline, not real-world effectiveness.',
    actionLabel: 'Open the quality review',
    route: (f) => casePath(f.caseTwo, 'quality'),
    done: secondInvestigationDone,
  },
  {
    id: 'compare-outcomes',
    persona: 'manager',
    title: 'Outcomes compared',
    description:
      'Both cases are compared on quality, avoidable effort, customer effort and token efficiency, with estimate labels.',
    presenterNotes:
      'All figures are model estimates for two synthetic cases (n=2). They illustrate the pipeline and are not evidence of real-world effectiveness.',
    actionLabel: 'Compare the two cases',
    route: comparePath,
    // The comparison is a view, not an action, so it can only be derived: it is available once both
    // cases have their metrics and the second investigation is recorded.
    done: (f) => hasMetrics(f.caseOne) && secondInvestigationDone(f),
  },
];
