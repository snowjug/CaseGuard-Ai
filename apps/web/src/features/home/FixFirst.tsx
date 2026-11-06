'use client';

import type { CaseWarning, CommandCenter } from '@caseguard/schemas';
import {
  AnimatedList,
  Button,
  ButtonLink,
  Card,
  CopyButton,
  StatusBadge,
  UiLink,
  cg,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { CircleCheckIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { caseHref, evidenceLinkHref } from '../../lib/deep-links';
import { CRITICALITY_LABELS, PRIORITY_BADGES } from '../../lib/labels';

const SHOWN = 3;

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    height: '100%',
    boxSizing: 'border-box',
  },
  head: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: cg.space[3],
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
    color: cg.text,
  },
  count: { fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  list: { display: 'flex', flexDirection: 'column', gap: cg.space[3], margin: 0, padding: 0 },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: `${cg.space[3]} ${cg.space[4]}`,
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceSunken,
    minWidth: 0,
  },
  itemHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  itemTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  link: {
    color: cg.text,
    textDecorationLine: 'none',
    ':hover': { color: cg.tone.brand.fg, textDecorationLine: 'underline' },
    ':focus-visible': {
      outline: `2px solid ${cg.focus}`,
      outlineOffset: '2px',
      borderRadius: cg.radius.sm,
    },
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  textOpen: { display: 'block', WebkitLineClamp: 'unset' },
  askRow: { display: 'flex', alignItems: 'flex-start', gap: cg.space[1] },
  good: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: cg.space[2],
    padding: `${cg.space[4]} 0`,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  goodIcon: { color: cg.tone.productive.fg, fontSize: tokens.fontSizeBase600 },
  goodTitle: {
    margin: 0,
    color: cg.text,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
});

type Fix =
  | { kind: 'warning'; id: string; warning: CaseWarning }
  | { kind: 'missing'; id: string; item: CommandCenter['criticalMissingEvidence'][number] };

export interface FixFirstProps {
  warnings: readonly CaseWarning[];
  missing: CommandCenter['criticalMissingEvidence'];
  caseId: string;
  /** A reusable fix that matches this case, offered when nothing needs fixing first. */
  skillMatch: CommandCenter['skillMatch'];
  /** True when the score is not good: with nothing open, the review still has lessons to show. */
  hasLessons: boolean;
}

/** The short list of what to do first: open warnings by priority, then evidence the case still needs. */
export function FixFirst({ warnings, missing, caseId, skillMatch, hasLessons }: FixFirstProps) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  const fixes = useMemo<Fix[]>(
    () => [
      ...[...warnings]
        .sort((a, b) => a.rank - b.rank)
        .map((warning): Fix => ({ kind: 'warning', id: `warning:${warning.id}`, warning })),
      ...missing
        .filter((item) => item.resolvedAt === null)
        .map((item): Fix => ({ kind: 'missing', id: `missing:${item.id}`, item })),
    ],
    [warnings, missing],
  );
  const visible = expanded ? fixes : fixes.slice(0, SHOWN);

  return (
    <Card as="section" padding="lg" className={styles.card} aria-labelledby="home-fix-first">
      <div className={styles.head}>
        <h2 id="home-fix-first" className={styles.title}>
          Fix first
        </h2>
        {fixes.length > 0 ? <span className={styles.count}>{fixes.length} in total</span> : null}
      </div>
      {fixes.length === 0 ? (
        <div className={styles.good}>
          <span aria-hidden="true" className={styles.goodIcon}>
            <CircleCheckIcon />
          </span>
          <p className={styles.goodTitle}>
            {hasLessons ? 'Nothing is open on this case' : 'Nothing needs fixing first'}
          </p>
          <span>
            {hasLessons
              ? 'It has no open warnings and no missing evidence. The review lists what to do differently next time.'
              : 'This case has no open warnings and no missing evidence.'}
          </span>
          {hasLessons ? (
            <ButtonLink href={caseHref(caseId, 'review')} variant="secondary" size="sm">
              See what to improve
            </ButtonLink>
          ) : null}
          {skillMatch ? (
            <span>
              A reusable fix matches it:{' '}
              <UiLink
                href={`/skills/${encodeURIComponent(skillMatch.skillId)}`}
                className={styles.link}
              >
                {skillMatch.name}
              </UiLink>
            </span>
          ) : null}
        </div>
      ) : (
        <>
          <AnimatedList
            className={styles.list}
            aria-label="Fixes, most important first"
            items={visible}
            getKey={(fix) => fix.id}
            renderItem={(fix) =>
              fix.kind === 'warning' ? (
                <div className={styles.item}>
                  <div className={styles.itemHead}>
                    <StatusBadge
                      status={PRIORITY_BADGES[fix.warning.priority].status}
                      label={PRIORITY_BADGES[fix.warning.priority].label}
                      size="small"
                    />
                  </div>
                  <h3 className={styles.itemTitle}>
                    <UiLink
                      href={
                        fix.warning.evidence[0]
                          ? evidenceLinkHref(caseId, fix.warning.evidence[0])
                          : caseHref(caseId, 'review')
                      }
                      className={styles.link}
                    >
                      {fix.warning.title}
                    </UiLink>
                  </h3>
                  <p className={styles.text} title={fix.warning.suggestedAction}>
                    {fix.warning.suggestedAction}
                  </p>
                </div>
              ) : (
                <div className={styles.item}>
                  <div className={styles.itemHead}>
                    <StatusBadge
                      status="missing"
                      label={`${CRITICALITY_LABELS[fix.item.criticality]} · missing`}
                      size="small"
                    />
                  </div>
                  <h3 className={styles.itemTitle}>
                    <UiLink
                      href={evidenceLinkHref(caseId, { type: 'requirement', id: fix.item.id })}
                      className={styles.link}
                    >
                      {fix.item.label}
                    </UiLink>
                  </h3>
                  <div className={styles.askRow}>
                    <p className={styles.text} title={fix.item.askText}>
                      Ask: {fix.item.askText}
                    </p>
                    <CopyButton
                      value={fix.item.askText}
                      label={`Copy the question for ${fix.item.label}`}
                    />
                  </div>
                </div>
              )
            }
          />
          {fixes.length > SHOWN ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Show fewer' : `Show all ${fixes.length}`}
            </Button>
          ) : null}
        </>
      )}
    </Card>
  );
}
