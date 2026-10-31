import { describe, expect, it, vi } from 'vitest';
import { ConflictError, RateLimitedError, VersionConflictError } from '../src/errors';
import { REPLAY_CACHE_ENTRIES } from '../src/services/counterfactuals/replay';
import { EngineBudget } from '../src/services/engine-budget';
import { APPLY_ATTEMPTS } from '../src/services/skills/application';
import { MAX_USAGE_CASES } from '../src/services/skills/measure';
import { ORIGIN_ID, SKILL_ID, copyId, createWorld } from './skills-world';

/*
 * Applying a skill to a case, against an in-memory world (fake repositories, the real services and the
 * real engine on the synthetic cases): what an application costs in engine work and in the caller's
 * budget, and what happens when someone else changes the skill while it is being measured. The
 * database-backed counterpart (real transactions and locks) is in skills-story.int.test.ts.
 */

/** Earlier applications of the skill: one more than an effectiveness estimate re-measures. */
const EARLIER = MAX_USAGE_CASES + 1;
const ENGINEER = 'user_engineer';
const slow = { timeout: 180_000 };

const applied = (world: ReturnType<typeof createWorld>) =>
  world.audits().filter((event) => event.action === 'skill.applied');

describe('what an application costs in engine work', () => {
  it(
    'charges one unit for every measurement no cache can serve, and runs no more passes than units',
    slow,
    async () => {
      const world = createWorld({ applications: EARLIER });
      const next = copyId(EARLIER + 1);
      world.addCase(next);
      const hook = vi.fn();

      const result = await world.applier.apply(world.ctxFor(ENGINEER), next, SKILL_ID, {
        beforeColdPass: hook,
      });
      expect(result).toMatchObject({ caseId: next, applied: true, appliedBy: ENGINEER });

      // The recorded path of the origin, the case itself and the newest MAX_USAGE_CASES - 1 earlier
      // applications; the two oldest are only counted. Each is a different case, measured once.
      const newest = Array.from({ length: MAX_USAGE_CASES - 1 }, (_, i) => copyId(EARLIER - i));
      expect(world.replays.loaded).toEqual([ORIGIN_ID, next, ...newest]);
      expect(hook).toHaveBeenCalledTimes(MAX_USAGE_CASES + 1);
      expect(world.replays.passes).toBe(hook.mock.calls.length);
      expect(world.skill().effectiveness).toMatchObject({
        applications: EARLIER + 1,
        matchedCases: EARLIER + 1,
      });
      expect(applied(world)).toHaveLength(1);
    },
  );

  it(
    'serves the earlier applications from the cache, so the next one replays only its own case',
    slow,
    async () => {
      const world = createWorld({ applications: EARLIER });
      const ctx = world.ctxFor(ENGINEER);
      const [first, second] = [copyId(EARLIER + 1), copyId(EARLIER + 2)] as const;
      world.addCase(first);
      world.addCase(second);
      await world.applier.apply(ctx, first, SKILL_ID);

      const loadedBefore = world.replays.loaded.length;
      const hook = vi.fn();
      await world.applier.apply(ctx, second, SKILL_ID, { beforeColdPass: hook });

      // A cache hit never reaches the replay loader: nine earlier applications and the origin are free.
      expect(world.replays.loaded.slice(loadedBefore)).toEqual([second]);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(world.replays.passes).toBe(loadedBefore + 1);
      expect(world.skill().effectiveness.applications).toBe(EARLIER + 2);
    },
  );

  it(
    'keeps the replays of one application’s walk, so repeating the walk runs no engine pass',
    slow,
    async () => {
      // The origin, the case itself and MAX_USAGE_CASES - 1 earlier applications are read in the same order
      // every time: a cache smaller than that walk would miss on every step of it.
      const world = createWorld({ applications: MAX_USAGE_CASES });
      const ctx = world.ctxFor(ENGINEER);
      const walk = [
        ORIGIN_ID,
        ...Array.from({ length: MAX_USAGE_CASES }, (_, i) => copyId(MAX_USAGE_CASES - i)),
      ];
      expect(walk).toHaveLength(MAX_USAGE_CASES + 1);

      for (const caseId of walk) await world.replays.load(ctx, caseId);
      expect(world.replays.passes).toBe(walk.length);
      for (const caseId of walk) await world.replays.load(ctx, caseId);
      expect(world.replays.passes).toBe(walk.length);
      // The walk plus room to spare, so a case read once more in between does not push the walk out.
      expect(REPLAY_CACHE_ENTRIES).toBeGreaterThanOrEqual(MAX_USAGE_CASES + 2);
    },
  );

  it(
    'is refused by an empty budget before the engine runs, and resumes where it stopped',
    slow,
    async () => {
      const world = createWorld({ applications: EARLIER });
      const next = copyId(EARLIER + 1);
      world.addCase(next);
      const ctx = world.ctxFor(ENGINEER);
      const budget = new EngineBudget({ passes: 4, windowMs: 60_000 });
      const attempt = () =>
        world.applier.apply(ctx, next, SKILL_ID, { beforeColdPass: () => budget.charge(ctx) });
      const skillBefore = world.skill();

      // Four units pay for four measurements; the fifth is refused before its replay starts.
      await expect(attempt()).rejects.toBeInstanceOf(RateLimitedError);
      expect(world.replays.loaded).toHaveLength(4);
      expect(world.replays.passes).toBe(4);
      expect(world.audits()).toEqual([]);
      expect(world.skill()).toBe(skillBefore);
      expect(world.matches().some((match) => match.caseId === next)).toBe(false);

      // Retrying later does not pay again for what was measured: it carries on.
      world.advance(60_000);
      await expect(attempt()).rejects.toBeInstanceOf(RateLimitedError);
      expect(world.replays.loaded).toHaveLength(8);
      world.advance(60_000);
      await expect(attempt()).resolves.toMatchObject({ caseId: next, applied: true });

      expect(world.replays.loaded).toHaveLength(MAX_USAGE_CASES + 1);
      expect(new Set(world.replays.loaded).size).toBe(MAX_USAGE_CASES + 1);
      expect(applied(world)).toHaveLength(1);
      expect(world.skill().effectiveness.applications).toBe(EARLIER + 1);
    },
  );

  it('counts a past application that cannot be measured again, without logging anything about it', async () => {
    const world = createWorld({ applications: 3 });
    const next = copyId(4);
    world.addCase(next);
    world.replays.onLoad = (caseId) => {
      if (caseId === copyId(2)) throw new TypeError('MARKER-CASE-TEXT leaked into an error');
    };

    const result = await world.applier.apply(world.ctxFor(ENGINEER), next, SKILL_ID);

    expect(result).toMatchObject({ caseId: next, applied: true });
    expect(world.skill().effectiveness.applications).toBe(4);
    expect(world.warn).toHaveBeenCalledTimes(1);
    expect(world.warn.mock.calls[0]?.[0]).toEqual({
      skillId: SKILL_ID,
      caseId: copyId(2),
      errorName: 'TypeError',
    });
    expect(JSON.stringify(world.warn.mock.calls)).not.toContain('MARKER-CASE-TEXT');
  });
});

describe('when the skill changes while an application is being measured', () => {
  it(
    'counts an application that committed meanwhile, and measures nothing twice',
    slow,
    async () => {
      const world = createWorld({ applications: 3 });
      const [mine, theirs] = [copyId(4), copyId(5)] as const;
      world.addCase(mine);
      // Someone else applies the skill to another case while the newest earlier application is measured,
      // which is after the list of applications was read.
      let interleaved = false;
      world.replays.onLoad = (caseId) => {
        if (caseId !== copyId(3) || interleaved) return;
        interleaved = true;
        world.commitApplication(theirs, { userId: 'user_curator' });
      };
      const versionBefore = world.skill().version;

      const result = await world.applier.apply(world.ctxFor(ENGINEER), mine, SKILL_ID);

      expect(interleaved).toBe(true);
      expect(result).toMatchObject({ caseId: mine, applied: true, appliedBy: ENGINEER });
      // Three earlier applications, the one that committed meanwhile, and this one.
      expect(world.skill().effectiveness.applications).toBe(5);
      expect(world.skill().version).toBe(versionBefore + 2);
      expect(world.matches().filter((match) => match.applied)).toHaveLength(5);
      // The second attempt reused every measurement of the first: each case was replayed once.
      const loaded = world.replays.loaded;
      expect(new Set(loaded).size).toBe(loaded.length);
      expect(loaded).toContain(theirs);
      expect(applied(world)).toHaveLength(1);
    },
  );

  it(
    'gives up after a few lost races with a version conflict, and with no further engine work',
    slow,
    async () => {
      const world = createWorld({ applications: 2 });
      const mine = copyId(3);
      world.addCase(mine);
      let attempts = 0;
      world.hooks.beforeCommit = () => {
        attempts += 1;
        world.touchSkill();
      };
      const before = world.skill().effectiveness;

      const outcome = world.applier.apply(world.ctxFor(ENGINEER), mine, SKILL_ID);
      await expect(outcome).rejects.toBeInstanceOf(VersionConflictError);
      await expect(outcome).rejects.toMatchObject({ status: 409, code: 'version_conflict' });

      expect(attempts).toBe(APPLY_ATTEMPTS);
      // The origin, the case itself and the two earlier applications: measured once, not once per attempt.
      expect(world.replays.passes).toBe(4);
      expect(world.skill().effectiveness).toEqual(before);
      expect(world.audits()).toEqual([]);
      expect(world.matches().some((match) => match.caseId === mine)).toBe(false);
    },
  );

  it('refuses a skill that was retired meanwhile instead of recording an application on it', async () => {
    const world = createWorld({ applications: 2 });
    const mine = copyId(3);
    world.addCase(mine);
    world.replays.onLoad = (caseId) => {
      if (caseId === mine) world.touchSkill({ lifecycle: 'retired' });
    };

    const outcome = world.applier.apply(world.ctxFor(ENGINEER), mine, SKILL_ID);

    await expect(outcome).rejects.toBeInstanceOf(ConflictError);
    await expect(outcome).rejects.toThrow(/Only pilot, validated or published skills/);
    expect(world.audits()).toEqual([]);
    expect(world.matches().some((match) => match.caseId === mine)).toBe(false);
  });

  it('does not record the match of an old version once the skill has a new current version', async () => {
    const world = createWorld({ applications: 2 });
    const mine = copyId(3);
    world.addCase(mine);
    world.replays.onLoad = (caseId) => {
      if (caseId === mine) world.touchSkill({ currentVersionId: 'skv_next_version' });
    };

    const outcome = world.applier.apply(world.ctxFor(ENGINEER), mine, SKILL_ID);

    await expect(outcome).rejects.toBeInstanceOf(ConflictError);
    await expect(outcome).rejects.toThrow(/moved to a new version/);
    expect(world.audits()).toEqual([]);
    expect(world.matches().some((match) => match.caseId === mine)).toBe(false);
  });

  it('leaves an application recorded meanwhile as it was: no second write, no second audit event', async () => {
    const world = createWorld({ applications: 2 });
    const mine = copyId(3);
    world.addCase(mine);
    // Recorded behind this request's back without a new version of the skill, so only the transaction's
    // own look at the stored match can notice it.
    world.replays.onLoad = (caseId) => {
      if (caseId === mine) {
        world.commitApplication(mine, { userId: 'user_curator', bumpVersion: false });
      }
    };
    const before = world.skill();

    const result = await world.applier.apply(world.ctxFor(ENGINEER), mine, SKILL_ID);

    expect(result).toMatchObject({ caseId: mine, applied: true, appliedBy: 'user_curator' });
    expect(world.skill()).toBe(before);
    expect(world.audits()).toEqual([]);
  });

  it('measures nothing for an application recorded after the caller looked', async () => {
    const world = createWorld({ applications: 2 });
    const mine = copyId(2);
    // The caller's listing is stale: it still shows the case as not applied.
    world.hooks.computed = (caseId) => {
      const stored = world.matches().find((match) => match.caseId === caseId);
      if (stored === undefined) throw new Error('the case has no stored match');
      return { ...stored, applied: false, appliedAt: null, appliedBy: null, conformance: null };
    };
    const before = world.skill();

    const result = await world.applier.apply(world.ctxFor(ENGINEER), mine, SKILL_ID);

    expect(result).toMatchObject({ caseId: mine, applied: true, appliedBy: 'user_other' });
    expect(world.replays.loaded).toEqual([]);
    expect(world.skill()).toBe(before);
    expect(world.audits()).toEqual([]);
  });
});
