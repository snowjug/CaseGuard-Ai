'use client';

import type { HypothesesResponse, Hypothesis } from '@caseguard/schemas';
import { MODEL_ESTIMATE_NOTICE } from '@caseguard/schemas';
import {
  ConfidenceBand,
  DataTable,
  KeyValueList,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatDuration,
  formatNumber,
  formatProbability,
  type DataTableColumn,
} from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { useMemo, useState } from 'react';
import { evidenceLinkHref } from '../../lib/deep-links';
import { shortId } from '../../lib/format';
import { CRITICALITY_LABELS } from '../../lib/labels';
import { EvidenceItem } from '../reasoning/EvidenceItem';
import {
  EFFORT_LABELS,
  HYPOTHESIS_STATUS_BADGES,
  HYPOTHESIS_STATUS_MEANING,
  LEVEL_LABELS,
} from '../reasoning/labels';
import { TruncatedText } from '../reasoning/TruncatedText';
import {
  evidenceFor,
  latestPoint,
  missingFor,
  statusChanges,
  type StatusChange,
  type WeighedEvidence,
} from './model';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  h3: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  list: {
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
  change: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
  },
  details: {
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    padding: `${cg.space[1]} ${cg.space[3]}`,
    backgroundColor: cg.surface,
  },
  summary: {
    cursor: 'pointer',
    minHeight: '32px',
    display: 'flex',
    alignItems: 'center',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  missing: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px dashed ${cg.borderControl}`,
    listStyle: 'none',
  },
  link: {
    color: cg.textLink,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    minHeight: '24px',
    display: 'inline-flex',
    alignItems: 'center',
  },
});

const INITIAL_EVIDENCE = 3;

function EvidenceGroup({
  heading,
  intro,
  items,
  caseId,
  empty,
}: {
  heading: string;
  intro: string;
  items: readonly WeighedEvidence[];
  caseId: string;
  empty: string;
}) {
  const styles = useStyles();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, INITIAL_EVIDENCE);
  return (
    <section className={styles.section} aria-label={heading}>
      <h3 className={styles.h3}>
        {heading} ({items.length})
      </h3>
      <p className={styles.muted}>{intro}</p>
      {items.length === 0 ? (
        <p className={styles.text}>{empty}</p>
      ) : (
        <ul className={styles.list}>
          {shown.map(({ evidence, link }) => (
            <EvidenceItem
              key={link.id}
              evidence={evidence}
              caseId={caseId}
              bearing={{
                polarity: link.polarity,
                effectOnConfidence: link.effectOnConfidence,
                rationale: link.rationale,
              }}
            />
          ))}
        </ul>
      )}
      {items.length > INITIAL_EVIDENCE ? (
        <div>
          <Button
            size="small"
            appearance="outline"
            aria-expanded={all}
            onClick={() => setAll((value) => !value)}
          >
            {all ? 'Show fewer' : `Show all ${items.length}`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ChangeRow({ change, caseId }: { change: StatusChange; caseId: string }) {
  const styles = useStyles();
  const from = change.from ? HYPOTHESIS_STATUS_BADGES[change.from].label : 'Start';
  const to = HYPOTHESIS_STATUS_BADGES[change.to];
  return (
    <li className={styles.change}>
      <span className={styles.text}>
        <strong>
          {from} → {to.label}
        </strong>{' '}
        at {formatDateTimeUtc(change.at)} ({formatProbability(change.confidence)}, estimate)
      </span>
      <span className={styles.muted}>
        <TruncatedText text={change.reason} limit={180} /> ·{' '}
        <UiLink
          className={styles.link}
          href={evidenceLinkHref(caseId, { type: 'event', id: change.eventId })}
        >
          Event {shortId(change.eventId, 12)}
        </UiLink>
      </span>
    </li>
  );
}

export interface HypothesisDetailProps {
  hypothesis: Hypothesis;
  data: Pick<HypothesesResponse, 'links' | 'evidence' | 'missing'>;
  caseId: string;
  /** In-page link to the action ranking. */
  rankingHref: string;
}

/** Everything one hypothesis stands on: why it moved, the evidence for and against, what is missing and how to test it. */
export function HypothesisDetail({ hypothesis, data, caseId, rankingHref }: HypothesisDetailProps) {
  const styles = useStyles();
  const status = HYPOTHESIS_STATUS_BADGES[hypothesis.currentStatus];
  const evidence = useMemo(
    () => evidenceFor(hypothesis, data.links, data.evidence),
    [hypothesis, data.links, data.evidence],
  );
  const missing = useMemo(() => missingFor(hypothesis, data.missing), [hypothesis, data.missing]);
  const changes = useMemo(() => statusChanges(hypothesis.timeline), [hypothesis.timeline]);
  const latest = latestPoint(hypothesis);
  const action = hypothesis.cheapestSafeAction;

  const historyColumns: DataTableColumn<Hypothesis['timeline'][number]>[] = [
    { id: 'at', header: 'When (UTC)', cell: (p) => formatDateTimeUtc(p.at), rowHeader: true },
    {
      id: 'confidence',
      header: 'Confidence',
      cell: (p) =>
        `${formatProbability(p.confidence)} (${formatProbability(p.low)}–${formatProbability(p.high)})`,
    },
    {
      id: 'delta',
      header: 'Change',
      align: 'end',
      cell: (p) => `${formatNumber(p.delta * 100, { maximumFractionDigits: 1, signed: true })} pts`,
    },
    { id: 'status', header: 'Status', cell: (p) => HYPOTHESIS_STATUS_BADGES[p.status].label },
    { id: 'reason', header: 'Why', cell: (p) => <TruncatedText text={p.reason} limit={140} /> },
  ];

  return (
    <Panel
      title={hypothesis.name}
      accent="hypothesis"
      description={hypothesis.description}
      help="Everything here is a model estimate built from the evidence on record at the selected time. Each item names the evidence, when it became known and how far it moved the confidence."
    >
      <div className={styles.badges}>
        <StatusBadge status={status.status} label={status.label} />
        <ProvenanceBadge kind="estimated" label="Model estimate" />
        <span className={styles.muted}>{HYPOTHESIS_STATUS_MEANING[hypothesis.currentStatus]}</span>
      </div>
      {hypothesis.engineerAnchoredAt ? (
        <Notice variant="info" compact title="Anchored">
          The engineer committed to this explanation at{' '}
          {formatDateTimeUtc(hypothesis.engineerAnchoredAt)}, by a statement or an action.
        </Notice>
      ) : null}

      <section className={styles.section} aria-label="Confidence">
        <h3 className={styles.h3}>Confidence</h3>
        <ConfidenceBand
          confidence={hypothesis.currentConfidence}
          low={hypothesis.currentLow}
          high={hypothesis.currentHigh}
          label={hypothesis.name}
        />
        <p className={styles.muted}>
          Started at {formatProbability(hypothesis.prior)} before any evidence.{' '}
          {MODEL_ESTIMATE_NOTICE}
        </p>
      </section>

      <section className={styles.section} aria-label="Why it is where it is">
        <h3 className={styles.h3}>Why it is where it is</h3>
        {latest ? (
          <p className={styles.text}>
            <TruncatedText text={latest.reason} limit={240} />
          </p>
        ) : (
          <p className={styles.text}>No evidence has moved this hypothesis yet.</p>
        )}
        {changes.length > 0 ? (
          <>
            <p className={styles.muted}>Promotions and demotions</p>
            <ol className={styles.list} aria-label="Promotions and demotions">
              {changes.map((change) => (
                <ChangeRow key={`${change.at}-${change.to}`} change={change} caseId={caseId} />
              ))}
            </ol>
          </>
        ) : null}
        {hypothesis.timeline.length > 0 ? (
          <details className={styles.details}>
            <summary className={styles.summary}>
              Full confidence history ({hypothesis.timeline.length} points)
            </summary>
            <DataTable
              caption={`Confidence history of ${hypothesis.name}`}
              columns={historyColumns}
              rows={hypothesis.timeline}
              getRowId={(p) => `${p.at}-${p.eventId}`}
              dense
            />
          </details>
        ) : null}
      </section>

      <EvidenceGroup
        heading="Evidence that supports it"
        intro="Strongest effect on the confidence first. Every item links to the event it came from."
        items={evidence.supporting}
        caseId={caseId}
        empty="No evidence on record supports this hypothesis at this time."
      />
      <EvidenceGroup
        heading="Evidence that contradicts it"
        intro="Contradictions are kept visible, not averaged away."
        items={evidence.contradicting}
        caseId={caseId}
        empty="Nothing on record contradicts this hypothesis at this time."
      />

      <section className={styles.section} aria-label="Missing evidence">
        <h3 className={styles.h3}>Missing evidence ({missing.open.length})</h3>
        <p className={styles.muted}>
          What the knowledge pack says is needed to confirm or rule this hypothesis in or out.
        </p>
        {missing.open.length === 0 ? (
          <p className={styles.text}>Nothing is missing for this hypothesis at this time.</p>
        ) : (
          <ul className={styles.list}>
            {missing.open.map((item) => (
              <li key={item.id} className={styles.missing}>
                <span className={styles.text}>
                  <strong>{item.label}</strong> · {CRITICALITY_LABELS[item.criticality]}
                </span>
                <span className={styles.muted}>{item.description}</span>
                <span className={styles.muted}>Suggested ask: “{item.askText}”</span>
              </li>
            ))}
          </ul>
        )}
        {missing.collected.length > 0 ? (
          <p className={styles.muted}>
            Already collected:{' '}
            {missing.collected
              .map((item) => `${item.label} (${formatDateTimeUtc(item.resolvedAt)})`)
              .join('; ')}
            .
          </p>
        ) : null}
      </section>

      <section className={styles.section} aria-label="Assumptions">
        <h3 className={styles.h3}>Assumptions ({hypothesis.assumptions.length})</h3>
        {hypothesis.assumptions.length === 0 ? (
          <p className={styles.text}>This hypothesis relies on no stated assumptions.</p>
        ) : (
          <ul className={styles.bullets}>
            {hypothesis.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-label="Cheapest safe validating action">
        <h3 className={styles.h3}>Cheapest safe validating action</h3>
        {action ? (
          <>
            <p className={styles.text}>
              <strong>{action.label}</strong> <ProvenanceBadge kind="estimated" />
            </p>
            <p className={styles.muted}>
              <TruncatedText text={action.rationale} limit={240} />
            </p>
            <KeyValueList
              columns={3}
              items={[
                {
                  label: 'Expected information',
                  value: `${formatNumber(action.expectedInformationGainBits, { maximumFractionDigits: 2 })} bits`,
                },
                {
                  label: 'Action value',
                  value: formatNumber(action.actionValue, { maximumFractionDigits: 2 }),
                },
                { label: 'Risk', value: LEVEL_LABELS[action.risk] },
                { label: 'Customer effort', value: EFFORT_LABELS[action.customerEffort] },
                {
                  label: 'Tokens',
                  value: `≈ ${formatNumber(action.tokenEstimate, { maximumFractionDigits: 0 })}`,
                },
                { label: 'Time', value: `≈ ${formatDuration(action.timeMinutes)}` },
              ]}
            />
            <UiLink className={styles.link} href={rankingHref}>
              See where it ranks among all candidate actions
            </UiLink>
          </>
        ) : (
          <p className={styles.text}>
            {hypothesis.currentStatus === 'confirmed' || hypothesis.currentStatus === 'ruled_out'
              ? 'Nothing more needs testing: this hypothesis is already settled on the evidence.'
              : 'No safe validating action is suggested at this time.'}
          </p>
        )}
      </section>
    </Panel>
  );
}
