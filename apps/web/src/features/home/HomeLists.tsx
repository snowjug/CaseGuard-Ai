'use client';

import type { CaseSummary, CommandCenter } from '@caseguard/schemas';
import { SKILL_LIFECYCLE_LABELS } from '@caseguard/schemas';
import {
  Badge,
  ButtonLink,
  Card,
  RelativeTime,
  StatusBadge,
  UiLink,
  cg,
  formatNumber,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ChevronRightIcon, PuzzleIcon } from 'lucide-react';
import { caseHref } from '../../lib/deep-links';
import { ANALYSIS_STATE_BADGES, SKILL_APPLICABILITY } from '../../lib/labels';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    height: '100%',
    boxSizing: 'border-box',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[3],
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
  },
  list: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyleType: 'none' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    minHeight: '56px',
    padding: `${cg.space[2]} ${cg.space[3]}`,
    marginInline: `calc(${cg.space[3]} * -1)`,
    borderRadius: cg.radius.md,
    color: cg.text,
    textDecorationLine: 'none',
    transitionProperty: 'background-color',
    transitionDuration: cg.motion.fast,
    ':hover': { backgroundColor: cg.surfaceSunken },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '-2px' },
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    flex: '1 1 auto',
  },
  reference: {
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  name: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
  },
  side: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: cg.space[1],
    flexShrink: 0,
  },
  score: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  muted: { fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  chevron: { flexShrink: 0, color: cg.textMuted },
  empty: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  skillIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderRadius: cg.radius.md,
    backgroundColor: cg.tone.brand.tint,
    color: cg.tone.brand.fg,
  },
});

/** The most recent cases, five at most: one row each, the score on the right, the whole row a link to the review. */
export function RecentCases({ cases }: { cases: readonly CaseSummary[] }) {
  const styles = useStyles();
  return (
    <Card as="section" padding="lg" className={styles.card} aria-labelledby="home-recent">
      <div className={styles.head}>
        <h2 id="home-recent" className={styles.title}>
          Recent cases
        </h2>
        <ButtonLink href="/cases" variant="ghost" size="sm">
          All cases
        </ButtonLink>
      </div>
      <ul className={styles.list}>
        {cases.slice(0, 5).map((item) => {
          const analysed = item.analysisState === 'analyzed';
          const analysis = ANALYSIS_STATE_BADGES[item.analysisState];
          return (
            <li key={item.id}>
              <UiLink
                href={caseHref(item.id, analysed ? 'review' : undefined)}
                className={styles.row}
              >
                <span className={styles.main}>
                  <span className={styles.reference}>{item.reference}</span>
                  <span className={styles.name}>{item.title}</span>
                </span>
                <span className={styles.side}>
                  {analysed && item.qualityIndex !== null ? (
                    <span className={styles.score}>
                      <span className="cg-sr-only">Score </span>
                      {formatNumber(item.qualityIndex, { maximumFractionDigits: 0 })}
                    </span>
                  ) : (
                    <StatusBadge status={analysis.status} label={analysis.label} size="small" />
                  )}
                  <span className={styles.muted}>
                    <RelativeTime value={item.analyzedAt ?? item.openedAt} />
                  </span>
                </span>
                <ChevronRightIcon aria-hidden="true" className={styles.chevron} />
              </UiLink>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export interface SkillsToReuseProps {
  match: CommandCenter['skillMatch'];
  candidates: CommandCenter['skillCandidates'];
}

/** Reusable fixes: the one that matches the case on show first, then the newest candidates. Quiet when there are none. */
export function SkillsToReuse({ match, candidates }: SkillsToReuseProps) {
  const styles = useStyles();
  const rest = candidates.filter((skill) => skill.id !== match?.skillId).slice(0, match ? 2 : 3);
  return (
    <Card as="section" padding="lg" className={styles.card} aria-labelledby="home-skills">
      <div className={styles.head}>
        <h2 id="home-skills" className={styles.title}>
          Skills you could reuse
        </h2>
        <ButtonLink href="/skills" variant="ghost" size="sm">
          All skills
        </ButtonLink>
      </div>
      {!match && rest.length === 0 ? (
        <p className={styles.empty}>
          Skills are reusable fixes. They appear after a case has been reviewed.
        </p>
      ) : (
        <ul className={styles.list}>
          {match ? (
            <li key={`match-${match.skillId}`}>
              <UiLink href={`/skills/${encodeURIComponent(match.skillId)}`} className={styles.row}>
                <span className={styles.skillIcon} aria-hidden="true">
                  <PuzzleIcon />
                </span>
                <span className={styles.main}>
                  <span className={styles.muted}>
                    Best match for this case · {formatProbability(match.score)}, estimated
                  </span>
                  <span className={styles.name}>{match.name}</span>
                </span>
                <StatusBadge
                  status={SKILL_APPLICABILITY[match.applicability].status}
                  label={SKILL_APPLICABILITY[match.applicability].label}
                  size="small"
                />
              </UiLink>
            </li>
          ) : null}
          {rest.map((skill) => (
            <li key={skill.id}>
              <UiLink href={`/skills/${encodeURIComponent(skill.id)}`} className={styles.row}>
                <span className={styles.skillIcon} aria-hidden="true">
                  <PuzzleIcon />
                </span>
                <span className={styles.main}>
                  <span className={styles.muted}>
                    Confidence {formatProbability(skill.confidence)}, estimated
                  </span>
                  <span className={styles.name}>{skill.name}</span>
                </span>
                <Badge tone="brand" size="sm">
                  {SKILL_LIFECYCLE_LABELS[skill.lifecycle]}
                </Badge>
              </UiLink>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
