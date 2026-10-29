import { describe, expect, it } from 'vitest';
import { SkillVersionSchema } from '@caseguard/schemas';
import {
  applySkillChangeSet,
  currentVersionOf,
  deriveSeedSkills,
  proposeMutations,
  type GuidedPlan,
} from '../src';
import { eventBySuffix } from './helpers';
import {
  CASEY,
  ONE,
  TWO,
  asOf,
  first,
  makeOp,
  matchAt,
  seeded,
  toSeedCase,
  versionOf,
  withPoisonedFuture,
} from './skills-fixtures';
import { planAt, published, recordedKeys, version } from './skills-story-fixtures';

describe('the skill learned from Case One guides Case Two', () => {
  it('[FR-SK-05] the demo skill is published only through the real gates, never by the seed', () => {
    expect(seeded().draft.skill.lifecycle).toBe('discovered');
    expect(published.skill.lifecycle).toBe('published');
    expect(published.approvals.map((a) => a.toState)).toEqual([
      'draft',
      'simulation_tested',
      'expert_reviewed',
      'pilot',
      'validated',
      'published',
    ]);
    const people = new Set(
      published.approvals
        .filter((a) => ['expert_reviewed', 'pilot', 'published'].includes(a.toState))
        .map((a) => a.approver),
    );
    expect(people.size).toBe(3);
    expect(people.has(published.skill.createdBy)).toBe(false);
  });

  it('[FR-SK-05] matches Case Two as of its first customer email, from that email alone', () => {
    const t = asOf(TWO, 'g01');
    const set = matchAt(TWO, t);
    const match = first(set.matches);
    expect(match).toMatchObject({
      skillName: 'Isolate a pre-authentication failure before pursuing identity policy',
      applicability: 'applies',
      asOf: t,
    });
    expect(match.unmatchedTriggers.map((u) => u.id)).toEqual(['trg-error-name-not-resolved']);
    expect(match.unmatchedTriggers[0]?.description).toMatch(/name-resolution/);
    expect(first(set.plans[match.skillId]?.nextSteps ?? [])).toMatchObject({
      actionKey: 'act.request-minimal-scoping',
      rank: 1,
    });
    expect(matchAt(TWO, t, undefined, withPoisonedFuture(TWO, t))).toEqual(set);
  });

  it('[FR-SK-05] still matches as of the first engineer reply and now recommends the service-health check', () => {
    const t = asOf(TWO, 'g02');
    const set = matchAt(TWO, t);
    const match = first(set.matches);
    expect(match.applicability).toBe('applies');
    const plan = set.plans[match.skillId];
    expect(plan?.steps.find((s) => s.actionKey === 'act.request-minimal-scoping')).toMatchObject({
      status: 'done',
      availability: 'completed',
    });
    expect(first(plan?.nextSteps ?? [])).toMatchObject({ actionKey: 'act.check-service-health' });
    expect(matchAt(TWO, t, undefined, withPoisonedFuture(TWO, t))).toEqual(set);
  });

  it('[FR-SK-05] the plan recommends, before each recorded step, the step the Case Two engineer then took', () => {
    const pairs = [
      ['g01', 'g02'],
      ['g02', 'g03'],
      ['g04', 'g05'],
      ['g07', 'g08'],
    ] as const;
    for (const [planned, taken] of pairs) {
      const recommended = first(planAt(TWO, planned).nextSteps).actionKey;
      const actual = TWO.analysis.actions.find(
        (a) => a.eventId === eventBySuffix(TWO, taken).id,
      )?.actionKey;
      expect(recommended, `plan as of ${planned}`).toBe(actual);
    }
  });

  it('[FR-SK-05] the plan walks the investigation ladder and shows what it is waiting for in between', () => {
    const keys = (plan: GuidedPlan) => plan.nextSteps.map((s) => s.actionKey);
    expect(planAt(TWO, 'g01').steps.map((s) => s.stage)).toEqual([1, 2, 3, 4, 4]);
    expect(keys(planAt(TWO, 'g03'))).toEqual([]);
    expect(planAt(TWO, 'g03').waitingOn).toEqual([
      'Sample affected users',
      'Exact failure timestamps (UTC)',
    ]);
    expect(keys(planAt(TWO, 'g04'))).toEqual(['act.signin-log-correlation']);
    expect(planAt(TWO, 'g05').waitingOn).toEqual([
      'The recorded result of “Correlate failing attempts with Entra sign-in logs”',
    ]);
    expect(keys(planAt(TWO, 'g05'))).toEqual([]);
    expect(new Set(keys(planAt(TWO, 'g06')))).toEqual(
      new Set(['act.dns-resolver-comparison', 'act.proxy-node-comparison']),
    );
    expect(keys(planAt(TWO, 'g07'))).toEqual([
      'act.proxy-node-comparison',
      'act.dns-resolver-comparison',
    ]);
    expect(planAt(TWO, 'g08')).toMatchObject({ status: 'in_progress', nextSteps: [] });
    expect(planAt(TWO, 'g08').waitingOn).toEqual([
      'The recorded result of “Compare sign-in connectivity through each proxy node”',
    ]);
    expect(planAt(TWO, 'g09')).toMatchObject({ status: 'success' });
    expect(planAt(TWO, 'g09').summary).toMatch(/success condition has been reached/);
  });

  it('[FR-SK-05] plans are monotone over time: a completed step never reopens and ranks follow action value', () => {
    const suffixes = Array.from({ length: 15 }, (_, i) => `g${String(i + 1).padStart(2, '0')}`);
    let done = new Set<string>();
    for (const suffix of suffixes) {
      const plan = planAt(TWO, suffix);
      const now = new Set(plan.steps.filter((s) => s.status === 'done').map((s) => s.stepId));
      for (const id of done) expect(now.has(id), `${id} as of ${suffix}`).toBe(true);
      done = now;
      const values = plan.nextSteps.map((s) => s.actionValue ?? 0);
      expect(values, suffix).toEqual([...values].sort((a, b) => b - a));
      expect(plan.nextSteps.map((s) => s.rank)).toEqual(plan.nextSteps.map((_, i) => i + 1));
      for (const step of plan.nextSteps) {
        expect(step.availability).toBe('ready');
        expect(step.executedAt).toBeNull();
      }
      expect(planAt(TWO, suffix)).toEqual(plan);
    }
    expect(done.size).toBe(4);
  });

  it('[FR-SK-05] the steps the engineer actually took are the planned steps, in the planned order', () => {
    const plan = planAt(TWO, 'g09');
    const taken = plan.steps
      .filter((s) => s.status === 'done')
      .sort((a, b) => (a.executedAt ?? '').localeCompare(b.executedAt ?? ''));
    expect(taken.map((s) => s.actionKey)).toEqual(recordedKeys);
    expect(taken.map((s) => s.stage)).toEqual([1, 2, 3, 4]);
    expect(recordedKeys).toEqual([
      'act.request-minimal-scoping',
      'act.check-service-health',
      'act.signin-log-correlation',
      'act.proxy-node-comparison',
    ]);
    expect(plan.steps.find((s) => s.actionKey === 'act.dns-resolver-comparison')?.status).toBe(
      'skipped',
    );
  });

  it('[FR-SK-05] the network-path stage lists both alternatives with the per-node PowerShell templates from the pack', () => {
    const stageFour = planAt(TWO, 'g06').steps.filter((s) => s.stage === 4);
    expect(stageFour.map((s) => s.actionKey).sort()).toEqual([
      'act.dns-resolver-comparison',
      'act.proxy-node-comparison',
    ]);
    for (const step of stageFour) {
      const powershell = step.templates.find((t) => t.language === 'powershell');
      const packTemplate = step.actionKey
        ? TWO.pack.actions.get(step.actionKey)?.templates.powershell
        : undefined;
      expect(powershell?.template, step.title).toBe(packTemplate);
      expect(step.safetyNotes.length).toBeGreaterThan(0);
      expect(step.expectedOutcomes.length).toBeGreaterThan(0);
      expect(step.estimatedMinutes && step.estimatedMinutes.low <= step.estimatedMinutes.high).toBe(
        true,
      );
    }
    const proxy = stageFour.find((s) => s.actionKey === 'act.proxy-node-comparison');
    const dns = stageFour.find((s) => s.actionKey === 'act.dns-resolver-comparison');
    const proxyTemplate = proxy?.templates.find((t) => t.language === 'powershell');
    expect(proxy).toMatchObject({ role: 'stage_alternative' });
    expect(proxyTemplate?.source).toBe('knowledge_pack');
    expect(proxyTemplate?.template).toMatch(/foreach \(\$p in \$proxies\)[\s\S]*Stopwatch/);
    expect(proxyTemplate?.parameters.map((p) => p.name)).toContain('proxy_list');
    expect(dns?.templates.find((t) => t.language === 'powershell')?.source).toBe('skill');
    const correlation = planAt(TWO, 'g06').steps.find(
      (s) => s.actionKey === 'act.signin-log-correlation',
    );
    expect(correlation?.templates.map((t) => t.language)).toEqual(['kql']);
  });

  it('[FR-SK-05] the plan carries the stop, escalation and safety conditions and tracks the minimum evidence', () => {
    const early = planAt(TWO, 'g01');
    expect(early.stopConditions.length).toBeGreaterThan(0);
    expect(early.escalationConditions[0]).toMatch(/minimum evidence/i);
    expect(early.safetyConstraints.join(' ')).toMatch(/never run a remediation/i);
    expect(early.labels).toEqual({ modelEstimate: true, estimated: true });
    expect(early.minimumEvidence.filter((m) => m.satisfied).map((m) => m.requirementId)).toEqual([
      'req.error-code',
    ]);
    expect(planAt(TWO, 'g09').minimumEvidence.every((m) => m.satisfied)).toBe(true);
  });
});

describe('Case Two also teaches the Case One skill a proxy branch', () => {
  const op = makeOp('story-mutation');
  const proposed = proposeMutations({
    aggregate: published,
    source: seeded().mutationSource,
    actor: CASEY,
    op,
  });
  if (!proposed.ok || proposed.value.status !== 'proposed') throw new Error('expected a proposal');
  const { proposal } = proposed.value;

  it('[FR-SK-04] proposes a new version with the proxy branch, a timeout trigger and the per-node PowerShell template', () => {
    expect(() => SkillVersionSchema.parse(proposal.version)).not.toThrow();
    expect(proposal.version).toMatchObject({
      version: '1.1.0',
      state: 'proposed',
      changeType: 'mutation',
      parentVersionId: version.id,
    });
    const content = proposal.version.content;
    expect(content.triggerConditions.find((c) => c.id === 'trg-error-timeout')).toMatchObject({
      kind: 'signal',
      required: false,
    });
    const proxyStep = content.decisionSequence.find(
      (s) => s.actionKey === 'act.proxy-node-comparison',
    );
    const dnsStep = content.decisionSequence.find(
      (s) => s.actionKey === 'act.dns-resolver-comparison',
    );
    expect(proxyStep?.order).toBe(dnsStep?.order);
    expect(proposal.mutations.map((m) => m.kind)).toEqual(
      expect.arrayContaining([
        'add_trigger',
        'promote_alternative',
        'add_query_template',
        'add_success_condition',
        'add_failure_mode',
        'add_source_case',
      ]),
    );
    const template = content.queryTemplates.find(
      (t) => t.id === 'tpl-proxy-node-comparison-powershell',
    );
    expect(template?.language).toBe('powershell');
    expect(template?.template).toBe(
      TWO.pack.actions.get('act.proxy-node-comparison')?.templates.powershell,
    );
    expect(content.knownFailureModes.join(' ')).toMatch(/proxy/i);
    expect(content.sourceCases.map((s) => [s.role, s.reference.split(' ')[0]])).toEqual([
      ['origin', 'CG-SYN-1001'],
      ['mutation_source', 'CG-SYN-1002'],
    ]);
  });

  it('[FR-SK-04] explains the change in plain sentences and marks what relied on hindsight', () => {
    const lines = proposal.diff.changes.map((c) => c.summary);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Added trigger condition: Client reports a connection timeout/),
        expect.stringMatching(
          /^Added query template: Compare sign-in connectivity through each proxy node \(PowerShell\)/,
        ),
      ]),
    );
    expect(proposal.diff).toMatchObject({ fromVersion: '1.0.0', toVersion: '1.1.0' });
    expect(proposal.mutations.find((m) => m.kind === 'promote_alternative')?.usesHindsight).toBe(
      true,
    );
    expect(proposal.mutations.find((m) => m.kind === 'add_query_template')?.usesHindsight).toBe(
      false,
    );
    expect(proposal.notices[0]).toMatch(/never applied automatically/);
  });

  it('[FR-SK-04] is never applied automatically: the published skill and its matches are unchanged until a distinct approver decides', () => {
    expect(proposal.changeSet.versionStates).toEqual([]);
    expect(proposal.changeSet.skill).toMatchObject({
      currentVersionId: version.id,
      currentVersion: '1.0.0',
      lifecycle: 'published',
      hasProposedMutation: true,
    });
    const after = applySkillChangeSet(published, proposal.changeSet);
    expect(currentVersionOf(after)?.id).toBe(version.id);
    expect(after.versions.find((v) => v.id === proposal.version.id)?.state).toBe('proposed');
    const t = asOf(TWO, 'g02');
    expect(matchAt(TWO, t, [{ skill: after.skill, version: versionOf(after) }])).toEqual(
      matchAt(TWO, t),
    );
  });

  it('[FR-SK-04] the proposal is reproducible from the same inputs', () => {
    const again = deriveSeedSkills({
      caseOne: toSeedCase(ONE),
      caseTwo: toSeedCase(TWO),
      proposer: CASEY,
      op: makeOp('seed'),
      rolloutCount: 60,
    });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value.draft.version.contentHash).toBe(seeded().draft.version.contentHash);
    expect(again.value.previewMutation?.version.contentHash).toBe(
      seeded().previewMutation?.version.contentHash,
    );
  });
});
