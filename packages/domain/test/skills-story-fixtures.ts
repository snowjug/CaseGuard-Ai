import type { SkillVersion } from '@caseguard/schemas';
import { buildGuidedPlan, checkConformance, type AnalysisAsOf, type GuidedPlan } from '../src';
import { CONFIG, type Prepared } from './helpers';
import { TWO, asOf, publishedAggregate, versionOf } from './skills-fixtures';

// Words that would turn a description of a route into a judgement of a person.
export const BLAME =
  /\b(wrong|mistake|poor(ly)?|bad(ly)?|blame\w*|punish\w*|violat\w*|non-?complian\w*|negligen\w*|careless\w*|should have|must have|ignored|neglect\w*|incompeten\w*|underperform\w*|penali[sz]\w*|fault\w*|deviat\w*|failed to|failure to)\b/i;

/** The demo skill after real governance: the Case One skill that the story applies to Case Two. */
export const published = publishedAggregate();
export const version = versionOf(published);

export const minutes = (from: string, to: string): number =>
  (Date.parse(to) - Date.parse(from)) / 60_000;

export const planAt = (
  p: Prepared,
  suffix: string,
  skillVersion: SkillVersion = version,
): GuidedPlan =>
  buildGuidedPlan({
    skill: published.skill,
    version: skillVersion,
    analysisAsOf: p.analysis,
    asOf: asOf(p, suffix),
    pack: p.pack,
    config: CONFIG,
    ctx: p.ctx,
  });

export const conformanceThrough = (
  p: Prepared,
  suffix: string,
  appliedAt: string | null,
  analysis: AnalysisAsOf = p.analysis,
) =>
  checkConformance({
    version,
    analysis,
    pack: p.pack,
    config: CONFIG,
    caseId: p.ctx.caseId,
    appliedAt,
    throughAt: asOf(p, suffix),
  });

/** The diagnostic steps the Case Two engineer actually took, in order (remediation excluded). */
export const recordedKeys = TWO.analysis.actions
  .map((a) => a.actionKey)
  .filter((k): k is string => k !== null && TWO.pack.actions.get(k)?.valueClass !== 'remediation');
