import type { CaseWarning, CounterfactualScenario } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import {
  CASE_ONE,
  CASE_TWO,
  OVERLAY_ONE,
  OVERLAY_TWO,
  type CaseFixture,
} from '../../../../test/review-fixtures';
import { deriveNextActions } from '../model/actions';
import { derivePaths } from '../model/paths';
import { denied, failed, loading, ready } from '../model/sources';
import { deriveVerdict } from '../model/verdict';
import {
  REPORT_SECTIONS,
  buildReport,
  reportFileName,
  reportSummary,
  type ReportInput,
} from './model';

const ROLE = 'Support engineer';

function inputOf(fixture: CaseFixture, overrides: Partial<ReportInput> = {}): ReportInput {
  const overlay = fixture === CASE_ONE ? OVERLAY_ONE : OVERLAY_TWO;
  return {
    detail: ready(fixture.detail),
    run: ready(fixture.run),
    quality: ready(fixture.quality),
    metrics: ready(fixture.metrics),
    coaching: ready(fixture.coaching),
    forks: ready(fixture.forks),
    scenarios: ready(fixture.scenarios),
    warnings: ready(fixture.warnings),
    ranking: ready(fixture.ranking),
    matches: ready(fixture.matches),
    overlays: { [overlay.matchId]: ready(overlay) },
    timeline: ready({
      events: fixture.timeline.events,
      total: fixture.timeline.total,
      truncated: false,
    }),
    claimReviews: ready([]),
    readAt: Date.parse('2026-03-12T15:30:00.000Z'),
    ...overrides,
  };
}

const included = <T>(part: { state: string; data?: T }): T => {
  if (part.state !== 'included' || part.data === undefined)
    throw new Error('expected an included part');
  return part.data;
};

describe('[REV-REPORT-01] the report is built from the same derivations as the review', () => {
  const report = buildReport(inputOf(CASE_ONE), ROLE);

  it('has nine sections in the order of the brief, all included for a role that can read everything', () => {
    expect(REPORT_SECTIONS.map((section) => section.id)).toEqual([
      'verdict',
      'chronology',
      'missed',
      'recorded',
      'better',
      'recommendations',
      'learning',
      'method',
      'review',
    ]);
    expect(report.pending).toBe(false);
    expect(report.leftOut).toEqual([]);
    for (const section of REPORT_SECTIONS) expect(report[section.id].state).toBe('included');
    expect(report.header).toMatchObject({
      reference: 'CG-SYN-1001',
      synthetic: true,
    });
    expect(report.fileName).toBe('CG-SYN-1001-guided-review.html');
  });

  it('shows the same verdict, paths and recommendations as the derivations the review uses', () => {
    expect(included(report.verdict).verdict).toEqual(
      deriveVerdict({
        quality: CASE_ONE.quality,
        coaching: CASE_ONE.coaching,
        forks: CASE_ONE.forks,
        detail: CASE_ONE.detail,
        metrics: CASE_ONE.metrics,
      }),
    );
    expect(included(report.better).view).toEqual(derivePaths(CASE_ONE.forks, CASE_ONE.scenarios));
    expect(included(report.recommendations).model).toEqual(
      deriveNextActions({
        quality: CASE_ONE.quality,
        warnings: CASE_ONE.warnings,
        coaching: CASE_ONE.coaching,
        ranking: CASE_ONE.ranking,
        executors: new Map(
          CASE_ONE.scenarios.flatMap((scenario) =>
            scenario.steps.map((step) => [step.actionKey, step.executor] as const),
          ),
        ),
      }),
    );
  });

  it('draws the chronology from the same geometry and marks every decision point', () => {
    const chronology = included(report.chronology);
    expect(chronology.chronology.events).toHaveLength(14);
    expect(chronology.chronology.decisionPoints).toHaveLength(9);
    expect(chronology.geometry.markers.filter((marker) => marker.kind === 'decision')).toHaveLength(
      9,
    );
    expect(chronology.decisionsMarked).toBe(true);
    expect(chronology.truncated).toBeNull();
  });

  it('gives the recorded side of the comparison from the simulated path, and says where it comes from', () => {
    const recorded = included(report.recorded);
    expect(recorded.decision).toMatchObject({
      number: 1,
      title: expect.stringMatching(/^Heavy customer request/),
    });
    expect(recorded.figuresFrom).toBe('simulation');
    expect(recorded.figures[0]).toEqual({ label: 'Time to useful evidence', text: '1 h 24 min' });
  });

  it('falls back to the analysis estimate for the recorded figure when no path was simulated', () => {
    const recorded = included(
      buildReport(inputOf(CASE_ONE, { scenarios: ready([]) }), ROLE).recorded,
    );
    expect(recorded.figuresFrom).toBe('decision point');
    expect(recorded.figures).toHaveLength(1);
    expect(recorded.figures[0]?.label).toBe('Time to useful evidence');
  });

  it('explains the method for every section that is in the report, once each', () => {
    const method = included(report.method);
    const headings = method.notes.map((note) => note.heading);
    expect(new Set(headings).size).toBe(headings.length);
    expect(headings).toEqual(
      expect.arrayContaining([
        'Case quality',
        'Key events and waits',
        'Decision points',
        'The better-supported path',
        'The list of next actions',
      ]),
    );
    expect(method.uncertainty.join(' ')).toMatch(/simulated estimate/);
    expect(method.uncertainty.join(' ')).toMatch(/Low confidence/);
  });
});

describe('[REV-REPORT-02] what the reader may not read is left out, never guessed', () => {
  it('leaves out the verdict for a role without case quality, with the permission and who has it', () => {
    const report = buildReport(
      inputOf(CASE_ONE, {
        quality: denied('quality:read'),
        coaching: denied('quality:read'),
        metrics: denied('quality:read'),
      }),
      'Skill curator',
    );
    expect(report.verdict).toMatchObject({ state: 'left-out', cause: 'permission' });
    expect(report.leftOut.map((item) => item.id)).toEqual(['verdict']);
    const note = report.leftOut[0]?.note ?? '';
    expect(note).toContain(
      'Your role (Skill curator) does not include the “quality:read” permission',
    );
    expect(note).toContain('the case quality result cannot be shown in this report');
    expect(note).toContain('Engineers, reviewers, managers and administrators can see it.');
    // The rest of the report stands, and says what it is missing.
    const recommendations = report.recommendations;
    expect(recommendations.state).toBe('included');
    if (recommendations.state === 'included') {
      expect(recommendations.notes.join(' ')).toContain(
        'so the quality improvements and the coach’s suggestion cannot be shown in this report',
      );
      expect(recommendations.notes).toHaveLength(1);
      expect(recommendations.data.model.items.every((item) => item.source !== 'improvement')).toBe(
        true,
      );
    }
    expect(report.method.state).toBe('included');
  });

  it('leaves out what failed to load and says to reload, while the chronology stays', () => {
    const report = buildReport(inputOf(CASE_ONE, { forks: failed(new Error('down')) }), ROLE);
    expect(report.missed).toMatchObject({ state: 'left-out', cause: 'failed' });
    expect(report.better).toMatchObject({ state: 'left-out', cause: 'failed' });
    expect(report.recorded).toMatchObject({ state: 'left-out', cause: 'failed' });
    expect(report.leftOut.find((item) => item.id === 'missed')?.note).toBe(
      'The decision points could not be read, so it is left out of this report. Reload the page to try again.',
    );
    const chronology = report.chronology;
    expect(chronology.state).toBe('included');
    if (chronology.state === 'included') {
      expect(chronology.data.decisionsMarked).toBe(false);
      expect(chronology.notes[0]).toContain('could not be read');
    }
  });

  it('is pending while any read is on its way, and never leaves a hole that looks like an answer', () => {
    const report = buildReport(inputOf(CASE_ONE, { timeline: loading() }), ROLE);
    expect(report.pending).toBe(true);
    expect(report.chronology).toMatchObject({ state: 'left-out', cause: 'loading' });
  });

  it('leaves out every recommendation source it cannot read as one section, and none of them as a guess', () => {
    const none = denied<never>('quality:read');
    const report = buildReport(
      inputOf(CASE_ONE, {
        quality: none,
        coaching: none,
        warnings: failed(new Error('x')),
        ranking: failed(new Error('x')),
      }),
      ROLE,
    );
    expect(report.recommendations.state).toBe('left-out');
  });

  it('names the sections that were left out in the short summary', () => {
    const report = buildReport(inputOf(CASE_ONE, { quality: denied('quality:read') }), ROLE);
    const summary = reportSummary(report, 'https://example.test/cases/c/report');
    expect(summary).toContain('Not included: verdict.');
    expect(summary).not.toContain('Case quality is');
  });
});

describe('[REV-REPORT-03] the better-supported path, honestly', () => {
  it('says nothing was simulated, and does not invent a path', () => {
    const better = included(buildReport(inputOf(CASE_ONE, { scenarios: ready([]) }), ROLE).better);
    expect(better.view.kind).toBe('not-simulated');
  });

  it('says there is nothing to compare for a case with no decision point', () => {
    const better = included(buildReport(inputOf(CASE_TWO), ROLE).better);
    expect(better.view.kind).toBe('no-decision-points');
    expect(included(buildReport(inputOf(CASE_TWO), ROLE).missed).moment).toBeNull();
  });
});

describe('[REV-REPORT-04] reusable learning with the server’s own numbers', () => {
  it('carries the overlay of each match as the server gave it, and a note where there is none', () => {
    const withOverlay = included(buildReport(inputOf(CASE_ONE), ROLE).learning);
    expect(withOverlay.matches).toHaveLength(1);
    expect(withOverlay.matches[0]?.overlay?.rows[0]).toMatchObject({
      label: 'Time to useful evidence',
      recorded: '240 min (120 min to 480 min)',
      withSkill: '150 min (0 min to 450 min)',
      saved: '90 min (30 min to 150 min)',
    });
    const missing = included(buildReport(inputOf(CASE_ONE, { overlays: {} }), ROLE).learning);
    expect(missing.matches[0]?.overlay).toBeNull();
    expect(missing.matches[0]?.overlayNote).toBe('The comparison with the skill was not read.');
    const forbidden = included(
      buildReport(
        inputOf(CASE_ONE, { overlays: { [OVERLAY_ONE.matchId]: denied('skill:read') } }),
        ROLE,
      ).learning,
    );
    expect(forbidden.matches[0]?.overlayNote).toContain('“skill:read” permission');
  });

  it('is left out for a role that cannot read skills', () => {
    const report = buildReport(inputOf(CASE_ONE, { matches: denied('skill:read') }), ROLE);
    expect(report.learning).toMatchObject({ state: 'left-out', cause: 'permission' });
  });
});

describe('[REV-REPORT-05] review and approval', () => {
  const scenario = CASE_ONE.scenarios[0] as CounterfactualScenario;
  const dismissed: CaseWarning = {
    ...(CASE_ONE.warnings[0] as CaseWarning),
    id: 'warn_dismissed',
    title: 'A warning someone dismissed',
    state: 'dismissed',
    dismissal: {
      by: 'user_ava_engineer',
      at: '2026-03-11T10:00:00.000Z',
      reason: 'Already handled in the call',
    },
  };

  it('lists what a human decided: claim reviews, path reviews, dismissed warnings and skill applications', () => {
    const review = included(
      buildReport(
        inputOf(CASE_ONE, {
          claimReviews: ready([
            {
              id: 'clm_1',
              text: 'Root cause is the policy',
              state: 'confirmed',
              by: 'user_rita_reviewer',
              at: '2026-03-11T09:00:00.000Z',
              reason: null,
            },
            {
              id: 'clm_2',
              text: 'The VPN is fine',
              state: 'rejected',
              by: 'user_rita_reviewer',
              at: '2026-03-11T09:05:00.000Z',
              reason: 'Contradicted by the sign-in logs',
            },
          ]),
          scenarios: ready([
            {
              ...scenario,
              reviewState: 'confirmed',
              reviewedBy: 'user_rita_reviewer',
              reviewedAt: '2026-03-11T11:00:00.000Z',
              reviewReason: 'Realistic and cheap',
            },
            ...CASE_ONE.scenarios.slice(1),
          ]),
          warnings: ready([dismissed, ...CASE_ONE.warnings]),
        }),
        ROLE,
      ).review,
    );
    expect(review.claims).toMatchObject({
      state: 'ready',
      counts: { confirmed: 1, corrected: 0, rejected: 1 },
    });
    expect(review.paths).toMatchObject({
      state: 'ready',
      items: [
        {
          stateLabel: 'Accepted',
          by: 'user_rita_reviewer',
          reason: 'Realistic and cheap',
        },
      ],
    });
    expect(review.dismissedWarnings).toMatchObject({
      state: 'ready',
      items: [
        {
          title: 'A warning someone dismissed',
          by: 'user_ava_engineer',
          reason: 'Already handled in the call',
        },
      ],
    });
    expect(review.skillApplications).toMatchObject({ state: 'ready', items: [] });
  });

  it('lists the adopted skill plan of the efficient case, with how closely it was followed', () => {
    const review = included(buildReport(inputOf(CASE_TWO), ROLE).review);
    expect(review.skillApplications).toMatchObject({
      state: 'ready',
      items: [
        {
          skillName: expect.stringMatching(/^Isolate a pre-authentication/),
          conformance: '4 of 4 steps followed',
        },
      ],
    });
  });

  it('says when and from which analysis run the report was generated, from the time the data was read', () => {
    const review = included(buildReport(inputOf(CASE_ONE), ROLE).review);
    expect(review.generated.at).toBe('2026-03-12T15:30:00.000Z');
    expect(review.generated.runId).toBe(CASE_ONE.run.id);
    expect(review.generated.sentence).toBe(
      `Generated at 12 Mar 2026, 15:30 UTC from analysis run ${CASE_ONE.run.id}. ${review.generated.producer}`,
    );
    const unknown = included(buildReport(inputOf(CASE_ONE, { readAt: 0 }), ROLE).review);
    expect(unknown.generated.at).toBeNull();
    expect(unknown.generated.sentence).toMatch(/^Generated from analysis run /);
  });

  it('says which parts it could not read instead of showing them as empty', () => {
    const review = included(
      buildReport(
        inputOf(CASE_ONE, { claimReviews: denied('case:read'), warnings: failed(new Error('x')) }),
        ROLE,
      ).review,
    );
    expect(review.claims).toMatchObject({ state: 'unavailable' });
    expect(review.dismissedWarnings).toMatchObject({
      state: 'unavailable',
      note: 'The dismissed warnings could not be read, so it is not included.',
    });
  });
});

describe('[REV-REPORT-06] the file name', () => {
  it('comes from the case reference and is safe on every system', () => {
    expect(reportFileName('CG-SYN-1001')).toBe('CG-SYN-1001-guided-review.html');
    expect(reportFileName('../../etc/passwd')).toBe('etc-passwd-guided-review.html');
    expect(reportFileName('a b:c*d?e"f<g>h|i')).toBe('a-b-c-d-e-f-g-h-i-guided-review.html');
    expect(reportFileName(null)).toBe('case-guided-review.html');
    expect(reportFileName('   ')).toBe('case-guided-review.html');
  });
});

describe('[REV-REPORT-07] the short summary', () => {
  it('is the same text as the share summary, from the report, and ends with the address of the report', () => {
    const report = buildReport(inputOf(CASE_ONE), ROLE);
    const summary = reportSummary(report, 'https://example.test/cases/c/report');
    expect(summary.split('\n')[0]).toBe(
      'CaseGuard guided review: CG-SYN-1001, Intermittent Teams sign-in failures for about 140 branch users (Pune and Leeds)',
    );
    expect(summary).toContain(
      'Case quality is poor: about 36 out of 100 (plausible range 32 to 39). This is an estimate.',
    );
    expect(summary).toContain(
      'Earliest important missed moment: Heavy customer request when a lighter ask was available',
    );
    expect(summary).toContain(
      'Next actions:\n1. Write causes as hypotheses until evidence supports them (critical)',
    );
    expect(summary.endsWith('Full report: https://example.test/cases/c/report')).toBe(true);
  });
});
