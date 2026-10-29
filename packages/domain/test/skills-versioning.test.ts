import { describe, expect, it } from 'vitest';
import {
  SkillDetailSchema,
  SkillDiffSchema,
  type SkillContent,
  type SkillVersion,
} from '@caseguard/schemas';
import {
  buildSkillDetail,
  currentVersionOf,
  diffSkillVersions,
  hashJson,
  proposeMutations,
} from '../src';
import {
  AVA,
  CASEY,
  IRRELEVANT,
  MORGAN,
  ONE,
  TWO,
  first,
  makeOp,
  seeded,
  toSeedCase,
} from './skills-fixtures';
import {
  approved,
  errorOf,
  proposal,
  proposed,
  published,
  v1,
  valueOf,
} from './skills-version-fixtures';

const skillId = published.skill.id;

const edited = (mutate: (c: SkillContent) => void): SkillVersion => {
  const content = structuredClone(v1.content);
  mutate(content);
  return {
    ...v1,
    id: 'skv_edited',
    version: '1.0.1',
    sequence: 2,
    parentVersionId: v1.id,
    content,
    contentHash: hashJson(content),
  };
};
const diffOf = (to: SkillVersion) => diffSkillVersions({ skillId, from: v1, to });
const lines = (to: SkillVersion): string[] => diffOf(to).changes.map((c) => c.summary);
const conditionOf = (id: string) => {
  const found = v1.content.triggerConditions.find((c) => c.id === id);
  if (!found) throw new Error(`No trigger ${id}`);
  return found;
};

describe('version diff', () => {
  it('[FR-SK-04] two identical versions have no differences', () => {
    const diff = diffOf({ ...v1, id: 'skv_same', version: '1.0.1' });
    expect(diff.changes).toEqual([]);
    expect(diff.summaryLines).toEqual(['No content differences between 1.0.0 and 1.0.1.']);
    expect(() => SkillDiffSchema.parse(diff)).not.toThrow();
  });

  it('[FR-SK-04] trigger conditions: added, removed and changed ones are each a sentence', () => {
    const site = conditionOf('trg-site-correlated');
    const intermittent = conditionOf('trg-intermittent-failures');
    const users = conditionOf('trg-multiple-users-affected');
    const next = edited((c) => {
      c.triggerConditions = c.triggerConditions
        .filter((t) => t.id !== site.id)
        .map((t) =>
          t.id === intermittent.id
            ? { ...t, weight: 0.5 }
            : t.id === users.id
              ? { ...t, required: !t.required }
              : t,
        );
      c.triggerConditions.push({
        id: 'trg-new',
        description: 'A new trigger',
        kind: 'text',
        pattern: 'timeout',
        weight: 0.2,
        required: true,
      });
    });
    const sentences = lines(next);
    expect(sentences).toContain(
      `Removed trigger condition: ${site.description}${site.required ? ' (required)' : ''}`,
    );
    expect(sentences).toContain('Added trigger condition: A new trigger (required)');
    expect(sentences).toContain(
      `Changed trigger condition “${intermittent.description}”: weight ${intermittent.weight} → 0.5`,
    );
    expect(sentences).toContain(
      `Changed trigger condition “${users.description}”: ${users.required ? 'no longer required' : 'now required'}`,
    );
    const changes = diffOf(next).changes;
    expect(changes.map((c) => [c.section, c.type])).toEqual(
      expect.arrayContaining([
        ['triggerConditions', 'added'],
        ['triggerConditions', 'removed'],
        ['triggerConditions', 'modified'],
      ]),
    );
    expect(changes.find((c) => c.type === 'added')?.path).toBe('triggerConditions[trg-new]');
  });

  it('[FR-SK-04] steps and branches: added, removed and changed ones say where they sit', () => {
    const stepOf = (key: string) => v1.content.decisionSequence.find((s) => s.actionKey === key);
    const dns = stepOf('act.dns-resolver-comparison');
    const health = stepOf('act.check-service-health');
    const correlation = stepOf('act.signin-log-correlation');
    if (!dns || !health || !correlation) throw new Error('expected the ladder steps');
    const branch = first(correlation.branches);
    const next = edited((c) => {
      c.decisionSequence = c.decisionSequence
        .filter((s) => s.id !== dns.id)
        .map((s) =>
          s.id === health.id
            ? { ...s, title: 'Check service health first' }
            : s.id === correlation.id
              ? {
                  ...s,
                  branches: s.branches.map((b, i) =>
                    i === 0 ? { ...b, next: 'escalate', probability: 0.9 } : b,
                  ),
                }
              : s,
        );
      c.decisionSequence.push({
        id: 'stp-5-escalate',
        order: 5,
        title: 'Escalate with the evidence',
        instruction: 'Hand over.',
        actionKey: null,
        expectedInformationGainBits: null,
        requiresInputs: [],
        branches: [],
      });
    });
    const sentences = lines(next);
    expect(sentences).toContain(`Removed step: ${dns.title} (stage 4)`);
    expect(sentences).toContain('Added step: Escalate with the evidence (stage 5)');
    expect(sentences).toContain('Changed step “Check service health first”: title updated');
    expect(
      sentences.find((s) =>
        s.startsWith(`Changed branch of step 3 “${branch.condition} → escalate”`),
      ),
    ).toMatch(/goes to escalate instead of .*; estimated probability .* → 0\.9$/);
  });

  it('[FR-SK-04] templates, constraints, conditions and confidence are covered as well', () => {
    const template = first(v1.content.queryTemplates);
    const next = edited((c) => {
      c.queryTemplates = [{ ...template, template: `${template.template}\n// extra` }];
      c.safetyConstraints = [...c.safetyConstraints, 'Never ask for credentials.'];
      c.stopConditions = c.stopConditions.slice(1);
      c.successConditions = [...c.successConditions, 'The failing node is isolated.'];
      c.confidence = { ...c.confidence, score: 0.5 };
      c.candidateActions = c.candidateActions.filter(
        (a) => a.actionKey !== 'act.proxy-node-comparison',
      );
    });
    const sentences = lines(next);
    expect(sentences).toContain(
      `Changed query template “${template.title}”: template text updated`,
    );
    expect(sentences).toContain('Added safety constraint: Never ask for credentials.');
    expect(sentences.some((s) => s.startsWith('Removed stop condition: '))).toBe(true);
    expect(sentences).toContain('Added success condition: The failing node is isolated.');
    expect(sentences).toContain(`Changed confidence estimate ${v1.content.confidence.score} → 0.5`);
    expect(sentences.some((s) => s.startsWith('Removed candidate action: '))).toBe(true);
    expect(SkillDiffSchema.parse(diffOf(next)).summaryLines[0]).toBe(
      `${sentences.length} changes between 1.0.0 and 1.0.1.`,
    );
  });

  it('[FR-SK-04] reversing a diff turns every addition into a removal, and the diff is deterministic', () => {
    const next = edited((c) => {
      c.safetyConstraints = [...c.safetyConstraints, 'Never ask for credentials.'];
    });
    const forward = diffOf(next);
    const back = diffSkillVersions({ skillId, from: next, to: v1 });
    expect(forward.changes.map((c) => c.type)).toEqual(['added']);
    expect(back.changes.map((c) => c.type)).toEqual(['removed']);
    expect(diffOf(next)).toEqual(forward);
  });
});

describe('proposing a mutation', () => {
  const propose = (over: Partial<Parameters<typeof proposeMutations>[0]> = {}) =>
    proposeMutations({
      aggregate: published,
      source: seeded().mutationSource,
      actor: CASEY,
      op: makeOp('m'),
      ...over,
    });

  it('[FR-SK-04] needs skill:mutate and the current skill version, and every refusal is audited', () => {
    expect(errorOf(propose({ actor: AVA }))).toMatchObject({
      code: 'forbidden',
      audit: {
        action: 'skill.mutation_denied',
        outcome: 'denied',
        actorId: AVA.id,
        caseId: TWO.ctx.caseId,
      },
    });
    expect(errorOf(propose({ expectedVersion: published.skill.version + 1 }))).toMatchObject({
      code: 'version_conflict',
      details: { expected: published.skill.version + 1, actual: published.skill.version },
      audit: { outcome: 'failure' },
    });
  });

  it('[FR-SK-04] teaches nothing new when the case is already a source, and refuses a repeat proposal', () => {
    const own = propose({ source: { ...seeded().mutationSource, caseId: ONE.ctx.caseId } });
    expect(valueOf(own)).toEqual({
      status: 'no_change',
      reasons: ['This case is already a source case of the skill.'],
    });
    expect(errorOf(propose({ aggregate: proposed }))).toMatchObject({
      code: 'conflict',
      details: { existingVersionId: proposal.version.id },
    });
  });

  it('[FR-SK-04] refuses another workload, an unresolved case and a skill that is no longer live', () => {
    const source = seeded().mutationSource;
    const other = propose({
      source: { ...source, caseInfo: { workload: 'exchange-mail-flow', product: 'Exchange' } },
    });
    expect(errorOf(other).code).toBe('validation_failed');
    expect(errorOf(propose({ source: { ...source, resolution: null } })).message).toMatch(
      /resolved case with a validated root cause/,
    );
    for (const lifecycle of ['deprecated', 'retired'] as const) {
      const gone = { ...published, skill: { ...published.skill, lifecycle } };
      expect(errorOf(propose({ aggregate: gone })).code).toBe('conflict');
    }
  });

  it('[FR-SK-04] a case with nothing new to teach yields no change instead of an empty version', () => {
    expect(valueOf(propose({ source: toSeedCase(IRRELEVANT) }))).toEqual({
      status: 'no_change',
      reasons: ['CG-SYN-9001 confirms nothing the skill does not already cover.'],
    });
    expect(valueOf(propose({ aggregate: approved }))).toEqual({
      status: 'no_change',
      reasons: ['This case is already a source case of the skill.'],
    });
  });
});

describe('skill detail', () => {
  it('[FR-SK-04] assembles the API detail with the proposed version, history and legal next steps', () => {
    const detail = valueOf(
      buildSkillDetail({
        aggregate: proposed,
        actor: CASEY,
        matches: [
          {
            caseId: TWO.ctx.caseId,
            caseReference: 'CG-SYN-1002',
            score: 0.75,
            applicability: 'applies',
            applied: false,
          },
        ],
      }),
    );
    expect(() => SkillDetailSchema.parse(detail)).not.toThrow();
    expect(detail.proposedVersion?.id).toBe(proposal.version.id);
    expect(detail.currentVersion.id).toBe(v1.id);
    expect(detail.versions.map((v) => v.version)).toEqual(['1.0.0', '1.1.0']);
    expect(detail.versions.every((v) => !('content' in v))).toBe(true);
    expect(detail.transitions).toEqual([
      expect.objectContaining({
        toState: 'deprecated',
        allowed: true,
        requiredPermission: 'skill:retire',
      }),
    ]);
    expect(detail.notices.join(' ')).toMatch(/never published automatically/);
    expect(detail.notices.join(' ')).toMatch(/synthetic demonstration data/);
    expect(detail.approvals.length).toBe(published.approvals.length);
  });

  it('[FR-SK-04] explains why a reader cannot take the next step, and fails cleanly without a current version', () => {
    const asReader = valueOf(buildSkillDetail({ aggregate: published, actor: MORGAN }));
    expect(asReader.transitions[0]).toMatchObject({ allowed: false });
    expect(asReader.transitions[0]?.reason).toMatch(/skill:retire/);
    expect(
      errorOf(buildSkillDetail({ aggregate: { ...published, versions: [] }, actor: CASEY })).code,
    ).toBe('not_found');
    expect(currentVersionOf(published)?.id).toBe(v1.id);
  });
});
