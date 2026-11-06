'use client';

import type { SkillDna, SkillValidationStatus } from '@caseguard/schemas';
import {
  Badge,
  BentoItem,
  BlurFade,
  Card,
  UiLink,
  cg,
  formatProbability,
  type BadgeProps,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { GitPullRequestArrowIcon, PuzzleIcon } from 'lucide-react';
import { formatNumber } from '../../lib/format';
import { LifecycleBadge, StatusExplanation, Tip } from './Hints';

export const VALIDATION_STATUS_LABELS: Record<SkillValidationStatus, string> = {
  unvalidated: 'Not validated yet',
  simulation_passed: 'Simulation test passed',
  expert_reviewed: 'Expert reviewed',
  pilot_validated: 'Pilot validated',
  validated: 'Validated',
};

const useStyles = makeStyles({
  cell: { height: '100%' },
  card: { height: '100%', boxSizing: 'border-box', gap: cg.space[4] },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[3],
  },
  tile: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    flexShrink: 0,
    borderRadius: cg.radius.md,
    backgroundColor: cg.tone.brand.tint,
    color: cg.tone.brand.fg,
    fontSize: tokens.fontSizeBase500,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    flex: '1 1 auto',
  },
  eyebrow: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
    overflowWrap: 'anywhere',
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  // The whole card is the click target: the title's link is stretched over it (one tab stop per card, a real heading).
  link: {
    color: 'inherit',
    textDecorationLine: 'none',
    '::after': { content: '""', position: 'absolute', inset: 0, borderRadius: cg.radius.lg },
    ':focus-visible': { outline: 'none' },
    ':focus-visible::after': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  summary: {
    margin: 0,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)',
    gap: cg.space[4],
    margin: 0,
    paddingTop: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
  },
  fact: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0, margin: 0 },
  factLabel: {
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontWeight: tokens.fontWeightMedium,
    color: cg.textSecondary,
  },
  factValue: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
  },
  factValueQuiet: { color: cg.textSecondary, fontWeight: tokens.fontWeightMedium },
  note: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
  tipBody: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
});

/**
 * The first sentences of a description that say what the skill is for. Descriptions start with where the skill came from
 * ("Distilled from CG-SYN-1001 (synthetic)."), which the skill's own page shows as its source; a card gives the part that
 * helps to choose. A description that is only that sentence is shown as it is.
 */
export function skillSummary(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  const rest = text.replace(/^Distilled from [^.]*\.\s+/, '');
  return rest.length > 0 ? rest : text;
}

/** "1 case", "3 cases", or "No cases yet": how often the skill was applied. */
export function usedOnText(applications: number): string {
  if (applications === 0) return 'No cases yet';
  return `${formatNumber(applications, { maximumFractionDigits: 0 })} ${applications === 1 ? 'case' : 'cases'}`;
}

function SuccessEstimateTip({ skill }: { skill: SkillDna }) {
  const styles = useStyles();
  const sources = skill.sourceCaseIds.length;
  return (
    <span className={styles.tipBody}>
      <span>
        <strong>Estimated success.</strong> A model estimate of how well this fix is likely to work.
        It is capped when few cases support it ({sources} source {sources === 1 ? 'case' : 'cases'})
        and is not a measurement.
      </span>
      {skill.synthetic ? (
        <span>Demo data: the figure shows how the pipeline works, not real-world results.</span>
      ) : null}
    </span>
  );
}

function ProposedBadge(props: Pick<BadgeProps, 'size'>) {
  return (
    <Badge tone="uncertain" icon={<GitPullRequestArrowIcon />} {...props}>
      Change proposed
    </Badge>
  );
}

export interface SkillCardProps {
  skill: SkillDna;
  /** 2 where the cards follow the page title directly, 3 inside a panel. */
  headingLevel?: 2 | 3;
  /** Position in the grid: the first cards fade in one after the other. */
  index?: number;
}

/**
 * One skill in the library, as a card: what it is for, where it stands, how far to trust it (an estimate) and how often it
 * was used. The whole card opens the skill; the status and the estimate explain themselves on hover.
 */
export function SkillCard({ skill, headingLevel = 3, index = 0 }: SkillCardProps) {
  const styles = useStyles();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const used = skill.effectiveness.applications;
  return (
    <BentoItem as="li" span={12} spanSm={6} spanLg={4}>
      <BlurFade index={index} className={styles.cell}>
        <Card interactive className={styles.card}>
          <div className={styles.head}>
            <span className={styles.tile} aria-hidden="true">
              <PuzzleIcon />
            </span>
            <Tip content={<StatusExplanation lifecycle={skill.lifecycle} />}>
              <LifecycleBadge lifecycle={skill.lifecycle} />
            </Tip>
          </div>
          <div className={styles.body}>
            <p className={styles.eyebrow}>
              {skill.product} · {skill.workload}
            </p>
            <Heading className={styles.title}>
              <UiLink href={`/skills/${encodeURIComponent(skill.id)}`} className={styles.link}>
                {skill.name}
              </UiLink>
            </Heading>
            <p className={styles.summary}>{skillSummary(skill.description)}</p>
            {skill.hasProposedMutation ? (
              <div className={styles.note}>
                <Tip content="Someone proposed a change to this skill. It waits for a decision and is never applied on its own.">
                  <ProposedBadge size="sm" />
                </Tip>
              </div>
            ) : null}
          </div>
          <dl className={styles.facts} aria-label={`Facts about ${skill.name}`}>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Estimated success</dt>
              <dd className={styles.factValue}>
                <Tip content={<SuccessEstimateTip skill={skill} />}>
                  {formatProbability(skill.confidence, 0)}
                </Tip>
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Used on</dt>
              <dd className={mergeClasses(styles.factValue, used === 0 && styles.factValueQuiet)}>
                <Tip
                  content={
                    skill.effectiveness.synthetic
                      ? 'How many cases this fix was applied to so far. Demo data: the cases are fictional.'
                      : 'How many cases this fix was applied to so far.'
                  }
                >
                  {usedOnText(used)}
                </Tip>
              </dd>
            </div>
          </dl>
        </Card>
      </BlurFade>
    </BentoItem>
  );
}
