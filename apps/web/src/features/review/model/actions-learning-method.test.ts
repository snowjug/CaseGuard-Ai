import type { ActionExecutor, ActionRanking, CaseWarning, SkillMatch } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import { CASE_ONE, CASE_TWO, OVERLAY_ONE, OVERLAY_TWO } from '../../../../test/review-fixtures';
import { GENERAL_GUIDANCE, deriveNextActions } from './actions';
import { deriveLearning, describeOverlay, overlayFigure } from './learning';
import { methodNotes, type MethodContext, type MethodSection } from './method';
import { derivePaths } from './paths';

const input = (fixture: typeof CASE_ONE) => ({
  quality: fixture.quality,
  warnings: fixture.warnings,
  coaching: fixture.coaching,
  ranking: fixture.ranking,
});

describe('[REV-ACTIONS-01] the one ranked list of next actions', () => {
  it('lists the quality improvements most urgent first, each with its reason, gain and evidence', () => {
    const model = deriveNextActions(input(CASE_ONE));
    expect(model.items).toHaveLength(8);
    expect(model.items.map((item) => item.priority)).toEqual([
      'critical',
      'critical',
      'critical',
      'high',
      'high',
      'medium',
      'medium',
      'medium',
    ]);
    const first = model.items[0];
    expect(first).toMatchObject({
      source: 'improvement',
      title: 'Write causes as hypotheses until evidence supports them',
      priorityLabel: 'Critical',
      gain: 'About +8 points of case quality (estimate)',
      hasEvidence: true,
      owner: null,
    });
    expect(first?.links.map((link) => link.type)).toEqual(['claim', 'claim', 'event', 'event']);
    // Within a priority the larger expected gain comes first.
    expect(model.items.slice(0, 3).map((item) => item.gainSize)).toEqual([8, 7, 6]);
  });

  it('lists a recommendation the coach repeats once, and marks it', () => {
    const model = deriveNextActions(input(CASE_ONE));
    expect(model.items.filter((item) => item.source === 'coaching')).toEqual([]);
    expect(model.items.filter((item) => item.alsoCoachesNext).map((item) => item.title)).toEqual([
      'Write causes as hypotheses until evidence supports them',
    ]);
  });

  it('says what became of the warnings of a finished case and why no diagnostic step is listed', () => {
    const model = deriveNextActions(input(CASE_ONE));
    expect(model.warnings).toEqual({ open: 0, resolved: 14, dismissed: 0 });
    expect(model.items.some((item) => item.source === 'warning')).toBe(false);
    expect(model.items.some((item) => item.source === 'diagnostic')).toBe(false);
    expect(model.noDiagnosticNote).toBe(
      'No diagnostic step is ranked as adding information at this point.',
    );
  });

  it('shows a coach’s suggestion with no evidence as general guidance, never with an invented link', () => {
    const model = deriveNextActions(input(CASE_TWO));
    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({
      source: 'coaching',
      title: 'Share what worked',
      priority: 'low',
      hasEvidence: false,
      links: [],
    });
    expect(GENERAL_GUIDANCE).toBe('General guidance — no case-specific evidence');
  });

  it('puts an open warning with its suggested action ahead of an improvement of the same priority', () => {
    const open: CaseWarning = {
      ...(CASE_ONE.warnings[0] as CaseWarning),
      state: 'open',
      resolvedAt: null,
      resolvedReason: null,
      priority: 'critical',
    };
    const model = deriveNextActions({ ...input(CASE_ONE), warnings: [open] });
    expect(model.items[0]).toMatchObject({
      source: 'warning',
      title: open.title,
      reason: open.message,
      suggestion: open.suggestedAction,
      sourceLabel: 'Open warning',
    });
    expect(model.warnings.open).toBe(1);
  });

  it('lists a diagnostic step only when it would add information, with its owner where the data says who', () => {
    const [candidate] = CASE_ONE.ranking.candidates;
    if (!candidate) throw new Error('fixture has a candidate');
    const ranking: ActionRanking = {
      ...CASE_ONE.ranking,
      candidates: [
        {
          ...candidate,
          rank: 1,
          score: 1.2,
          inputs: { ...candidate.inputs, expectedInformationGainBits: 0.53 },
        },
        { ...candidate, actionKey: 'act.none', label: 'Adds nothing', rank: 2, score: 0 },
      ],
    };
    const executors = new Map<string, ActionExecutor>([
      [candidate.actionKey, 'customer_network_admin'],
    ]);
    const model = deriveNextActions({
      quality: null,
      warnings: null,
      coaching: null,
      ranking,
      executors,
    });
    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({
      source: 'diagnostic',
      priority: 'high',
      owner: 'Customer network admin',
      gain: 'About 0.53 bits of new information (estimate)',
    });
    expect(model.noDiagnosticNote).toBeNull();
  });

  it('copes with every source missing', () => {
    expect(
      deriveNextActions({ quality: null, warnings: null, coaching: null, ranking: null }),
    ).toEqual({
      items: [],
      warnings: { open: 0, resolved: 0, dismissed: 0 },
      noDiagnosticNote: null,
    });
  });
});

describe('[REV-LEARN-01] skills that resemble the case', () => {
  it('describes the match of the efficient case: how well it fits, the evidence for it and how closely it was followed', () => {
    const { matches, notApplicable } = deriveLearning(CASE_TWO.matches);
    expect(notApplicable).toBe(0);
    expect(matches).toHaveLength(1);
    const [match] = matches;
    expect(match).toMatchObject({
      skillName: 'Isolate a pre-authentication failure before pursuing identity policy',
      lifecycleLabel: 'Published',
      scoreText: '75%',
      applicabilityLabel: 'Applies',
      applied: true,
      conformanceText: '4 of 4 steps followed',
      anyHindsight: true,
    });
    expect(match?.met).toHaveLength(4);
    expect(match?.unmet).toHaveLength(1);
    expect(match?.steps.map((step) => step.statusLabel)).toEqual([
      'Done',
      'Done',
      'Done',
      'Skipped',
      'Done',
    ]);
    expect(match?.links.every((link) => link.type === 'evidence')).toBe(true);
  });

  it('leaves out a skill that does not apply, and counts it', () => {
    const none: SkillMatch = {
      ...(CASE_TWO.matches[0] as SkillMatch),
      applicability: 'not_applicable',
    };
    expect(deriveLearning([none])).toEqual({ matches: [], notApplicable: 1 });
  });

  it('orders the skills that apply before the ones that partly apply, then by fit', () => {
    const base = CASE_TWO.matches[0] as SkillMatch;
    const result = deriveLearning([
      { ...base, id: 'a', skillName: 'A', applicability: 'partial', score: 0.9 },
      { ...base, id: 'b', skillName: 'B', applicability: 'applies', score: 0.5 },
      { ...base, id: 'c', skillName: 'C', applicability: 'applies', score: 0.7 },
    ]);
    expect(result.matches.map((match) => match.skillName)).toEqual(['C', 'B', 'A']);
  });
});

describe('[REV-LEARN-02] recorded against with the skill, as the server computed it', () => {
  it('shows the API’s figures exactly and does no arithmetic of its own', () => {
    const view = describeOverlay(OVERLAY_ONE);
    const time = view.rows.find((row) => row.key === 'time_to_useful_evidence_minutes');
    expect(time).toMatchObject({
      recorded: '240 min (120 min to 480 min)',
      withSkill: '150 min (0 min to 450 min)',
      saved: '90 min (30 min to 150 min)',
    });
    expect(time?.basis).toMatch(/never below zero/);
    expect(view.decision).toMatchObject({
      eventId: 'e03',
      title: expect.stringMatching(/^Heavy customer request/),
    });
    expect(view.recorded).toMatchObject({ followed: false });
    expect(view.cheaper).toMatchObject({ minutesSaved: '150 min of customer time (estimate)' });
    expect(view.nothingToCompare).toBe(false);
    expect(view.limitations[0]).toMatch(/extracted from this case/);
  });

  it('says so when the server could not compare a row, instead of filling it in', () => {
    const tokens = describeOverlay(OVERLAY_ONE).rows.find((row) => row.key === 'tokens');
    expect(tokens).toMatchObject({
      recorded: null,
      withSkill: null,
      saved: '3,000 tokens (1,000 tokens to 5,000 tokens)',
    });
    const none = describeOverlay(OVERLAY_TWO);
    expect(none.nothingToCompare).toBe(true);
    expect(none.decision).toBeNull();
    expect(none.recorded.followed).toBe(true);
    // Nothing recorded and nothing with the skill: only the rows that carry the skill's own saving are kept, and the
    // sentence they share is said once.
    expect(none.savingOnly?.rows.map((row) => row.key)).toEqual([
      'time_to_useful_evidence_minutes',
    ]);
    expect(none.savingOnly?.sharedBasis).toBe(none.rows[0]?.basis);
    expect(describeOverlay(OVERLAY_ONE).savingOnly).toBeNull();
  });

  it('says a basis that every saving shares once, and keeps the basis of each row when they differ', () => {
    const [row] = OVERLAY_TWO.comparison;
    const base = row as NonNullable<typeof row>;
    const same = describeOverlay({
      ...OVERLAY_TWO,
      comparison: [base, { ...base, key: 'customer_effort_minutes', label: 'Customer effort' }],
    });
    expect(same.savingOnly?.rows).toHaveLength(2);
    expect(same.savingOnly?.sharedBasis).toBe(base.basis);
    const differ = describeOverlay({
      ...OVERLAY_TWO,
      comparison: [base, { ...base, key: 'tokens', unit: 'tokens', basis: 'Another reason.' }],
    });
    expect(differ.savingOnly?.sharedBasis).toBeNull();
    expect(differ.savingOnly?.rows.map((entry) => entry.basis)).toEqual([
      base.basis,
      'Another reason.',
    ]);
  });

  it('keeps fractions as the server sent them, to two places, and a missing range as nothing', () => {
    expect(overlayFigure({ low: 69.04488, mid: 99.5955, high: 142.8988 }, 'minutes')).toBe(
      '99.6 min (69.04 min to 142.9 min)',
    );
    expect(overlayFigure(null, 'minutes')).toBeNull();
  });
});

describe('[REV-METHOD-01] how it was calculated, in plain language', () => {
  const path = derivePaths(CASE_ONE.forks, CASE_ONE.scenarios);
  const ctx: MethodContext = {
    run: CASE_ONE.run,
    quality: CASE_ONE.quality,
    coaching: CASE_ONE.coaching,
    detail: CASE_ONE.detail,
    path: path.kind === 'ready' ? path.path : null,
  };
  const sections: MethodSection[] = [
    'overall',
    'verdict',
    'chronology',
    'decisions',
    'paths',
    'actions',
    'learning',
  ];

  it('lists the quality areas with their weights and the configuration it used', () => {
    const [quality] = methodNotes('verdict', ctx);
    expect(quality?.facts).toContainEqual({
      label: 'Evidence integrity',
      value: '25% of the score',
    });
    expect(quality?.facts).toHaveLength(6);
    expect(quality?.paragraphs.join(' ')).toContain('configuration version 1.0.0');
    expect(quality?.paragraphs.join(' ')).toContain('6 problems, 32 points in total');
  });

  it('says honestly that fixed rules produced it, from the run, and names the run', () => {
    const [produced] = methodNotes('overall', ctx);
    expect(produced?.paragraphs[0]).toContain('No language model was involved');
    expect(produced?.facts).toContainEqual({ label: 'Analysis run', value: CASE_ONE.run.id });
    const model = methodNotes('overall', {
      ...ctx,
      run: { ...CASE_ONE.run, provider: 'azure-openai', model: 'gpt-x' },
    });
    expect(model[0]?.paragraphs[0]).toContain('gpt-x');
  });

  it('explains the simulation with its own figures, and marks synthetic data', () => {
    const [note] = methodNotes('paths', ctx);
    expect(note?.paragraphs.join(' ')).toContain('run 200 times');
    expect(note?.paragraphs.join(' ')).toContain('52% of those runs');
    expect(note?.paragraphs.join(' ')).toContain('A reviewer accepted this path');
    expect(methodNotes('overall', ctx).some((n) => n.heading === 'Synthetic data')).toBe(true);
  });

  it('never uses the engine’s internal words', () => {
    const everything = sections
      .flatMap((section) => methodNotes(section, ctx))
      .flatMap((note) => [
        note.heading,
        ...note.paragraphs,
        ...note.facts.flatMap((f) => [f.label, f.value]),
      ])
      .join('\n');
    expect(everything).not.toMatch(
      /\bfork|hypothes[ie]s|counterfactual|\bCQI\b|\bASE\b|claims? ledger|posterior|SkillDNA/i,
    );
  });

  it('still explains itself when the role cannot read the quality result', () => {
    const [quality] = methodNotes('verdict', { ...ctx, quality: null, qualityDenied: true });
    expect(quality?.paragraphs.join(' ')).toContain('your role cannot read it');
    const [loadingNote] = methodNotes('verdict', { ...ctx, quality: null });
    expect(loadingNote?.paragraphs.join(' ')).not.toContain('your role');
  });
});
