'use client';

import type { CounterfactualScenario, DecisionFork } from '@caseguard/schemas';
import { Panel, StatusBadge, cg, formatDateTimeUtc, formatNumber } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { LockClosedRegular } from '@fluentui/react-icons';
import { withheldAfterBoundary } from './model';

const useStyles = makeStyles({
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  lead: { display: 'flex', alignItems: 'flex-start', gap: cg.space[2] },
  leadIcon: { flexShrink: 0, marginTop: '2px', color: cg.textSecondary, fontSize: '18px' },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
    flex: '1 1 0',
    minWidth: 0,
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  bar: {
    display: 'flex',
    width: '100%',
    height: '18px',
    borderRadius: cg.radius.pill,
    overflow: 'hidden',
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surfaceSunken,
  },
  known: { backgroundColor: cg.tone.fork.solid, minWidth: '6px' },
  withheld: {
    flex: '1 1 auto',
    backgroundImage: `repeating-linear-gradient(135deg, transparent 0 5px, ${cg.borderControl} 5px 7px)`,
  },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: cg.space[2],
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  check: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[2],
    fontSize: tokens.fontSizeBase300,
    minWidth: 0,
  },
  checkText: { flex: '1 1 0', minWidth: 0, overflowWrap: 'anywhere' },
  details: {
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    padding: `${cg.space[1]} ${cg.space[3]}`,
    backgroundColor: cg.surface,
    minWidth: 0,
  },
  summary: {
    cursor: 'pointer',
    minHeight: '32px',
    display: 'flex',
    alignItems: 'center',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
});

const HELP =
  'The simulation is only allowed to use what was on record strictly before the decision instant. The API checks that no later event, no identifier that first appears later and no part of the final resolution was used, and records the result: this is the leak check. A path that fails it can be rejected but never accepted.';

export interface BoundaryPanelProps {
  fork: DecisionFork;
  scenario: CounterfactualScenario | null;
  /** Total events in the case, to say how many were withheld (null while the case loads). */
  caseEventCount: number | null;
}

/**
 * The temporal boundary of a simulation and the leak-check verdict: the decision instant, how many events were known
 * and how many were withheld, whether the final resolution was excluded, and every validity check with its result.
 */
export function BoundaryPanel({ fork, scenario, caseEventCount }: BoundaryPanelProps) {
  const styles = useStyles();
  const boundary = scenario?.boundary ?? null;
  const known = boundary?.eventCount ?? fork.informationAvailable.eventIds.length;
  const instant = boundary?.asOf ?? fork.eligibility.boundary;
  const withheld = scenario ? withheldAfterBoundary(scenario, caseEventCount) : null;
  const total = withheld === null ? null : known + withheld;
  const leak = boundary?.leakCheck ?? null;
  const leakPassed =
    leak !== null && leak.passed && leak.futureReferencesFound === 0 && leak.resolutionExcluded;
  const knownShare = total && total > 0 ? Math.max(0.04, Math.min(1, known / total)) : 0;

  return (
    <Panel
      title="Temporal boundary and leak check"
      description="What the simulation was allowed to know, and proof that it stayed inside that."
      help={HELP}
      accent="fork"
    >
      <div className={styles.lead}>
        <LockClosedRegular aria-hidden="true" className={styles.leadIcon} />
        <p className={styles.text}>
          <strong>Known as of {formatDateTimeUtc(instant)}</strong>, the moment of the decision. The
          decision itself and everything after it were withheld.
        </p>
      </div>
      {total !== null && withheld !== null ? (
        <div>
          <div
            className={styles.bar}
            role="img"
            aria-label={`${known} of ${total} events were known at the decision instant; ${withheld} later events were withheld`}
          >
            <span className={styles.known} style={{ width: `${knownShare * 100}%` }} />
            <span className={styles.withheld} />
          </div>
          <div className={styles.legend} aria-hidden="true">
            <span>
              {formatNumber(known, { maximumFractionDigits: 0 })} known
              {boundary ? ` · ${boundary.evidenceIds.length} evidence items` : ''}
            </span>
            <span>
              {formatNumber(withheld, { maximumFractionDigits: 0 })} later events withheld
            </span>
          </div>
        </div>
      ) : (
        <p className={styles.muted}>
          {known} events and{' '}
          {boundary?.evidenceIds.length ?? fork.informationAvailable.evidenceIds.length} evidence
          items were known at that moment.
        </p>
      )}
      {leak ? (
        <>
          <div className={styles.head}>
            <StatusBadge
              status={leakPassed ? 'productive' : 'unsupported'}
              label={leakPassed ? 'Leak check passed' : 'Leak check failed'}
            />
            <span className={styles.text}>
              {leak.futureReferencesFound === 0
                ? 'No reference to the future was found.'
                : `${leak.futureReferencesFound} reference${leak.futureReferencesFound === 1 ? '' : 's'} to the future found.`}{' '}
              {leak.resolutionExcluded
                ? 'The final resolution was excluded.'
                : 'The final resolution was NOT excluded.'}
            </span>
          </div>
          <ul className={styles.list} aria-label="Leak check details">
            {leak.details.map((detail) => (
              <li key={detail} className={styles.text}>
                {detail}
              </li>
            ))}
          </ul>
          <p className={styles.muted}>
            Checked {formatDateTimeUtc(leak.checkedAt, { seconds: true })}.
          </p>
        </>
      ) : (
        <p className={styles.text}>
          No simulated path exists for this fork yet, so there is no leak check to show. Every path
          that is generated records one.
        </p>
      )}
      {scenario ? (
        <details className={styles.details}>
          <summary className={styles.summary}>
            Validity checks ({scenario.validity.checks.filter((c) => c.passed).length} of{' '}
            {scenario.validity.checks.length} passed)
          </summary>
          <ul className={styles.list} aria-label="Validity checks">
            {scenario.validity.checks.map((check) => (
              <li key={check.id} className={styles.check}>
                <StatusBadge
                  status={check.passed ? 'productive' : 'unsupported'}
                  label={check.passed ? 'Passed' : 'Failed'}
                  size="small"
                />
                <span className={styles.checkText}>{check.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}
