'use client';

import type { DecisionFork, Evidence, ForkAlternative } from '@caseguard/schemas';
import { ACTION_KIND_LABELS } from '@caseguard/schemas';
import {
  AccordionItem,
  Card,
  KeyValueList,
  Notice,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatDuration,
  formatNumber,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { evidenceLinkHref } from '../../lib/deep-links';
import { EvidenceItem } from '../reasoning/EvidenceItem';
import { EFFORT_LABELS, LEVEL_LABELS } from '../reasoning/labels';
import { TruncatedText } from '../reasoning/TruncatedText';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  h3: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  h4: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  two: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 900px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    listStyle: 'none',
  },
  alternative: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    listStyle: 'none',
    padding: `${cg.space[4]} 0`,
    borderTop: `1px solid ${cg.borderSubtle}`,
    ':first-child': { borderTop: 0, paddingTop: 0 },
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  evidenceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  bullets: {
    margin: 0,
    paddingLeft: cg.space[4],
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  link: {
    color: cg.textLink,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    minHeight: '24px',
    display: 'inline-flex',
    alignItems: 'center',
  },
  check: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[2],
    fontSize: tokens.fontSizeBase300,
  },
});

function AlternativeCard({
  alternative,
  rank,
  caseId,
  evidenceById,
}: {
  alternative: ForkAlternative;
  rank: number;
  caseId: string;
  evidenceById: ReadonlyMap<string, Evidence> | null;
}) {
  const styles = useStyles();
  const evidence = alternative.supportingEvidenceIds.flatMap((id) => {
    const item = evidenceById?.get(id);
    return item ? [item] : [];
  });
  return (
    <li className={styles.alternative}>
      <div className={styles.head}>
        <strong>
          {rank}. {alternative.label}
        </strong>
        <StatusBadge
          status={alternative.safe ? 'productive' : 'unsupported'}
          label={alternative.safe ? 'Safe to suggest' : 'Blocked by the safety policy'}
          size="small"
        />
        <ProvenanceBadge kind="estimated" />
      </div>
      <p className={styles.muted}>{ACTION_KIND_LABELS[alternative.kind]}</p>
      <p className={styles.text}>
        <TruncatedText text={alternative.rationale} limit={260} />
      </p>
      {alternative.blockedReasons.length > 0 ? (
        <ul className={styles.bullets}>
          {alternative.blockedReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      <KeyValueList
        columns={3}
        items={[
          {
            label: 'Expected information',
            value: `${formatNumber(alternative.expectedInformationGainBits, { maximumFractionDigits: 2 })} bits`,
          },
          {
            label: 'Action value',
            value: `${formatNumber(alternative.actionValue, { maximumFractionDigits: 2 })} (${formatProbability(alternative.relativeValue)} of the best)`,
          },
          { label: 'Time', value: `≈ ${formatDuration(alternative.timeMinutes)}` },
          { label: 'Customer effort', value: EFFORT_LABELS[alternative.customerEffort] },
          {
            label: 'Operational risk',
            value: `${formatNumber(alternative.operationalRisk, { maximumFractionDigits: 2 })} of 1`,
          },
          {
            label: 'Tokens',
            value: `≈ ${formatNumber(alternative.tokenEstimate, { maximumFractionDigits: 0 })}`,
          },
        ]}
      />
      {alternative.requiresFirst.length > 0 ? (
        <p className={styles.muted}>Needs first: {alternative.requiresFirst.join('; ')}.</p>
      ) : null}
      <AccordionItem
        title={`Evidence this alternative rests on (${alternative.supportingEvidenceIds.length})`}
        headingLevel={4}
      >
        {alternative.supportingEvidenceIds.length === 0 ? (
          <p className={styles.text}>
            No evidence is cited: the alternative follows from the knowledge pack.
          </p>
        ) : evidence.length > 0 ? (
          <ul className={styles.evidenceList}>
            {evidence.map((item) => (
              <EvidenceItem key={item.id} evidence={item} caseId={caseId} />
            ))}
          </ul>
        ) : (
          <ul className={styles.bullets}>
            {alternative.supportingEvidenceIds.map((id) => (
              <li key={id}>
                <UiLink
                  className={styles.link}
                  href={evidenceLinkHref(caseId, { type: 'evidence', id })}
                >
                  Evidence {id}
                </UiLink>
              </li>
            ))}
          </ul>
        )}
      </AccordionItem>
    </li>
  );
}

export interface DecisionMomentProps {
  fork: DecisionFork;
  caseId: string;
  /** Evidence on record at the decision instant, by id (null while it loads or when unavailable). */
  evidenceById: ReadonlyMap<string, Evidence> | null;
}

/**
 * The fork as the engineer faced it: what was done, what was known and not yet known, the alternatives with their
 * evidence, estimated consequences, uncertainty and whether a simulation is allowed. Decision-time only: the hindsight
 * view of the same step lives in its own panel.
 */
export function DecisionMoment({ fork, caseId, evidenceById }: DecisionMomentProps) {
  const styles = useStyles();
  const { consequences } = fork;
  return (
    <div className={styles.stack}>
      <section className={styles.section} aria-label="What was done">
        <h3 className={styles.h3}>What was done</h3>
        <p className={styles.text}>
          <strong>{fork.actual.label}</strong>
          {fork.actual.kind ? ` (${ACTION_KIND_LABELS[fork.actual.kind]})` : ''}
        </p>
        <KeyValueList
          columns={3}
          items={[
            { label: 'Decision time', value: formatDateTimeUtc(fork.timestamp) },
            { label: 'Customer effort', value: EFFORT_LABELS[fork.actual.customerEffort] },
            {
              label: 'Operational risk',
              value: `${formatNumber(fork.actual.operationalRisk, { maximumFractionDigits: 2 })} of 1`,
            },
            {
              label: 'Action value at the time',
              value:
                fork.actual.actionValue === null
                  ? 'Not scored'
                  : `${formatNumber(fork.actual.actionValue, { maximumFractionDigits: 2 })}${
                      fork.actual.relativeValue === null
                        ? ''
                        : ` (${formatProbability(fork.actual.relativeValue)} of the best safe action)`
                    }`,
            },
            { label: 'Destructive', value: fork.actual.destructive ? 'Yes' : 'No' },
          ]}
        />
      </section>

      <div className={styles.two}>
        <section className={styles.section} aria-label="Information available">
          <h3 className={styles.h3}>Known at that moment</h3>
          <p className={styles.text}>{fork.informationAvailable.summary}</p>
          <p className={styles.muted}>
            {fork.informationAvailable.eventIds.length} events ·{' '}
            {fork.informationAvailable.evidenceIds.length} evidence items ·{' '}
            {fork.informationAvailable.claimIds.length} claims
          </p>
        </section>
        <section className={styles.section} aria-label="Information not yet available">
          <h3 className={styles.h3}>Not available yet</h3>
          {fork.informationUnavailable.length === 0 ? (
            <p className={styles.text}>Nothing relevant was missing.</p>
          ) : (
            <ul className={styles.bullets}>
              {fork.informationUnavailable.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={styles.section} aria-label="Reasonable alternatives">
        <h3 className={styles.h3}>Reasonable alternatives ({fork.alternatives.length})</h3>
        <p className={styles.muted}>
          Ranked by the action-value heuristic using only what was known then. Every figure is an
          estimate.
        </p>
        {fork.alternatives.length === 0 ? (
          <p className={styles.text}>No alternative action was identified for this key decision.</p>
        ) : (
          <ol className={styles.list}>
            {fork.alternatives.map((alternative, index) => (
              <AlternativeCard
                key={alternative.actionKey}
                alternative={alternative}
                rank={index + 1}
                caseId={caseId}
                evidenceById={evidenceById}
              />
            ))}
          </ol>
        )}
      </section>

      <section className={styles.section} aria-label="Estimated consequences">
        <div className={styles.head}>
          <h3 className={styles.h3}>Estimated consequences</h3>
          <ProvenanceBadge kind="estimated" />
        </div>
        <div className={styles.two}>
          <Card flat padding="sm" className={styles.card}>
            <h4 className={styles.h4}>The step taken</h4>
            <KeyValueList
              columns={1}
              items={[
                {
                  label: 'Time to useful evidence',
                  value: `${formatDuration(consequences.actual.timeToUsefulEvidenceMinutes.mid)} (range ${formatDuration(consequences.actual.timeToUsefulEvidenceMinutes.low)} to ${formatDuration(consequences.actual.timeToUsefulEvidenceMinutes.high)})`,
                },
                {
                  label: 'Customer effort',
                  value: formatProbability(consequences.actual.customerEffortScore),
                },
                {
                  label: 'Tokens',
                  value: `≈ ${formatNumber(consequences.actual.tokenEstimate, { maximumFractionDigits: 0 })}`,
                },
                { label: 'Risk', value: LEVEL_LABELS[consequences.actual.riskLevel] },
              ]}
            />
          </Card>
          <Card flat padding="sm" className={styles.card}>
            <h4 className={styles.h4}>The best alternative</h4>
            {consequences.bestAlternative ? (
              <KeyValueList
                columns={1}
                items={[
                  {
                    label: 'Time to useful evidence',
                    value: `${formatDuration(consequences.bestAlternative.timeToUsefulEvidenceMinutes.mid)} (range ${formatDuration(consequences.bestAlternative.timeToUsefulEvidenceMinutes.low)} to ${formatDuration(consequences.bestAlternative.timeToUsefulEvidenceMinutes.high)})`,
                  },
                  {
                    label: 'Customer effort',
                    value: formatProbability(consequences.bestAlternative.customerEffortScore),
                  },
                  {
                    label: 'Tokens',
                    value: `≈ ${formatNumber(consequences.bestAlternative.tokenEstimate, { maximumFractionDigits: 0 })}`,
                  },
                  { label: 'Risk', value: LEVEL_LABELS[consequences.bestAlternative.riskLevel] },
                ]}
              />
            ) : (
              <p className={styles.text}>No safe alternative was identified.</p>
            )}
          </Card>
        </div>
        <p className={styles.text}>{consequences.deltaSummary}</p>
      </section>

      <div className={styles.two}>
        <section className={styles.section} aria-label="Uncertainty">
          <h3 className={styles.h3}>Uncertainty</h3>
          <p className={styles.text}>
            <StatusBadge
              status={fork.uncertainty.level === 'high' ? 'uncertain' : 'productive'}
              label={`${LEVEL_LABELS[fork.uncertainty.level]} uncertainty`}
              size="small"
            />{' '}
            ({formatNumber(fork.uncertainty.score, { maximumFractionDigits: 2 })} of 1, estimate)
          </p>
          <p className={styles.text}>{fork.uncertainty.rationale}</p>
        </section>
        <section className={styles.section} aria-label="Simulation eligibility">
          <h3 className={styles.h3}>May it be simulated?</h3>
          <p className={styles.text}>
            <StatusBadge
              status={fork.eligibility.eligible ? 'productive' : 'unsupported'}
              label={fork.eligibility.eligible ? 'Eligible' : 'Not eligible'}
              size="small"
            />{' '}
            Boundary: {formatDateTimeUtc(fork.eligibility.boundary)}
          </p>
          <ul className={styles.list}>
            {fork.eligibility.checks.map((check) => (
              <li key={check.id} className={styles.check}>
                <StatusBadge
                  status={check.passed ? 'productive' : 'unsupported'}
                  label={check.passed ? 'Passed' : 'Failed'}
                  size="small"
                />
                <span>{check.detail}</span>
              </li>
            ))}
          </ul>
          {!fork.eligibility.eligible && fork.eligibility.reasons.length > 0 ? (
            <Notice variant="warning" compact title="Why not">
              {fork.eligibility.reasons.join(' ')}
            </Notice>
          ) : null}
        </section>
      </div>
    </div>
  );
}
