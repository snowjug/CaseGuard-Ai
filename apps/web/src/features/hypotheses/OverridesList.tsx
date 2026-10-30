'use client';

import { Notice, cg, formatDateTimeUtc } from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { HistoryRegular } from '@fluentui/react-icons';
import { useId, useState } from 'react';
import { formatInstant } from '../reasoning/format';
import { useActorLabel } from '../reasoning/hooks';
import { TruncatedText } from '../reasoning/TruncatedText';
import { withheldOverridesText, type OverrideEntry } from './model';

/** The newest overrides shown before "Show all": the API lists up to 200 per ranking. */
export const OVERRIDES_SHOWN = 8;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  h3: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  entry: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: `${cg.space[1]} ${cg.space[2]}`,
  },
  action: { fontWeight: tokens.fontWeightSemibold, color: cg.text, overflowWrap: 'anywhere' },
  rank: { fontVariantNumeric: 'tabular-nums', color: cg.textSecondary },
  facts: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
    overflowWrap: 'anywhere',
  },
  reason: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  noteAction: { marginTop: cg.space[1] },
  more: { alignSelf: 'flex-start' },
});

export interface OverridesListProps {
  entries: readonly OverrideEntry[];
  /** True for an earlier view: it lists only the overrides decided, and about a moment, by its end. */
  windowed: boolean;
  /** How many overrides this view cannot show: a count, never content. 0 (or absent) shows no note. */
  withheld: number;
  /** The moment this view is of, named by the note about what it cannot show. */
  viewAsOf: string;
  /** Leaves the earlier view for the whole record, where every override is listed. */
  onShowWholeRecord?: (() => void) | undefined;
}

/**
 * The reviewer overrides of the action ranking, newest decision first: which action, the rank the reviewer preferred (and
 * the machine's rank when the override is about the ranking on screen, the only one whose machine rank is known), the
 * moment the ranking it is about was evaluated at, who decided and when, and the reason as plain text. An earlier view
 * lists only what was known by its moment and says how many it cannot show, never what they are.
 */
export function OverridesList({
  entries,
  windowed,
  withheld,
  viewAsOf,
  onShowWholeRecord,
}: OverridesListProps) {
  const styles = useStyles();
  const actorLabel = useActorLabel();
  const headingId = useId();
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, OVERRIDES_SHOWN);
  const note = windowed ? withheldOverridesText(withheld, formatInstant(viewAsOf)) : null;

  return (
    <div className={styles.root} role="group" aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.h3}>
        Reviewer overrides ({entries.length})
      </h3>
      <p className={styles.muted}>
        {windowed
          ? 'The overrides recorded, and about a moment, by the end of this view, newest decision first.'
          : 'Every override recorded on this case, newest decision first.'}{' '}
        An override never replaces the machine rank.
      </p>
      {note ? (
        <Notice variant="info" compact title={null}>
          {note}
          {onShowWholeRecord ? (
            <div className={styles.noteAction}>
              <Button
                size="small"
                appearance="outline"
                icon={<HistoryRegular />}
                onClick={onShowWholeRecord}
              >
                Show the whole record
              </Button>
            </div>
          ) : null}
        </Notice>
      ) : null}
      {entries.length === 0 ? (
        <p className={styles.muted}>
          {windowed
            ? 'No reviewer override had been recorded by this moment.'
            : 'No reviewer has overridden an action ranking on this case yet.'}
        </p>
      ) : (
        <ul className={styles.list} aria-label="Reviewer overrides">
          {shown.map(({ record, machineRank, aboutThisRanking }) => (
            <li key={`${record.instant}|${record.actionKey}`} className={styles.entry}>
              <span className={styles.head}>
                <span className={styles.action}>{record.actionName}</span>
                <span className={styles.rank}>
                  Reviewer rank <strong>{record.rank}</strong>
                  {machineRank !== null ? `, machine rank ${machineRank}` : ''}
                </span>
              </span>
              <p className={styles.facts}>
                About the ranking at {formatInstant(record.instant)}
                {aboutThisRanking ? ', the one shown here' : ''}. Decided by {actorLabel(record.by)}{' '}
                on {formatDateTimeUtc(record.at)}.
              </p>
              <p className={styles.reason}>
                “<TruncatedText text={record.reason} limit={240} />”
              </p>
            </li>
          ))}
        </ul>
      )}
      {entries.length > OVERRIDES_SHOWN ? (
        <Button
          size="small"
          appearance="outline"
          className={styles.more}
          aria-expanded={all}
          onClick={() => setAll((value) => !value)}
        >
          {all ? `Show the newest ${OVERRIDES_SHOWN}` : `Show all ${entries.length} overrides`}
        </Button>
      ) : null}
    </div>
  );
}
