'use client';

import type { HypothesesResponse, Hypothesis } from '@caseguard/schemas';
import { MODEL_ESTIMATE_NOTICE } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  Badge,
  Button,
  ConfidenceBand,
  DataTable,
  KeyValueList,
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
import { makeStyles, tokens } from '@fluentui/react-components';
import { AnchorIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { evidenceLinkHref } from '../../lib/deep-links';
import { shortId } from '../../lib/format';
import { CRITICALITY_LABELS } from '../../lib/labels';
import {
  EFFORT_LABELS,
  HYPOTHESIS_STATUS_BADGES,
  HYPOTHESIS_STATUS_MEANING,
  LEVEL_LABELS,
} from '../reasoning/labels';
import { TruncatedText } from '../reasoning/TruncatedText';
import { EvidenceLine } from './EvidenceLine';
import {
  evidenceFor,
  missingFor,
  standingReason,
  statusChanges,
  type StatusChange,
  type WeighedEvidence,
} from './model';

const useStyles = makeStyles({
  head: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
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
    gap: cg.space[3],
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
    gap: cg.space[1],
    minWidth: 0,
    paddingLeft: cg.space[3],
    borderLeft: `2px solid ${cg.borderSubtle}`,
  },
  missing: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    paddingLeft: cg.space[3],
    borderLeft: `2px dashed ${cg.borderControl}`,
    listStyle: 'none',
  },
  link: {
    color: cg.textLink,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    minHeight: '24px',
    display: 'inline-flex',
    alignItems: 'center',
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  linkButton: {
    display: 'inline',
    padding: 0,
    border: 0,
    backgroundColor: 'transparent',
    color: cg.textLink,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    textAlign: 'start',
    textDecorationLine: 'underline',
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
});

const INITIAL_EVIDENCE = 3;

function EvidenceGroup({
  intro,
  items,
  caseId,
  empty,
}: {
  intro: string;
  items: readonly WeighedEvidence[];
  caseId: string;
  empty: string;
}) {
  const styles = useStyles();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, INITIAL_EVIDENCE);
  return (
    <div className={styles.section}>
      <p className={styles.muted}>{intro}</p>
      {items.length === 0 ? (
        <p className={styles.text}>{empty}</p>
      ) : (
        <ul className={styles.list}>
          {shown.map(({ evidence, link }) => (
            <EvidenceLine
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
            variant="secondary"
            size="sm"
            aria-expanded={all}
            onClick={() => setAll((value) => !value)}
          >
            {all ? 'Show fewer' : `Show all ${items.length}`}
          </Button>
        </div>
      ) : null}
    </div>
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
  /** Goes to the ranking of next tests (the drawer closes, the ranking opens). */
  onShowRanking: () => void;
}

/**
 * Everything one possible cause stands on, for the drawer: why it moved, the evidence for and against, what is missing and
 * how to test it. Each part is a row that opens, so the long ones do not push the rest away.
 */
export function HypothesisDetail({
  hypothesis,
  data,
  caseId,
  onShowRanking,
}: HypothesisDetailProps) {
  const styles = useStyles();
  const status = HYPOTHESIS_STATUS_BADGES[hypothesis.currentStatus];
  const evidence = useMemo(
    () => evidenceFor(hypothesis, data.links, data.evidence),
    [hypothesis, data.links, data.evidence],
  );
  const missing = useMemo(() => missingFor(hypothesis, data.missing), [hypothesis, data.missing]);
  const changes = useMemo(() => statusChanges(hypothesis.timeline), [hypothesis.timeline]);
  const reason = standingReason(hypothesis);
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
    <>
      <div className={styles.head}>
        <p className={styles.text}>{hypothesis.description}</p>
        <div className={styles.badges}>
          <StatusBadge status={status.status} label={status.label} />
          <ProvenanceBadge kind="estimated" label="Model estimate" />
        </div>
        <p className={styles.muted}>{HYPOTHESIS_STATUS_MEANING[hypothesis.currentStatus]}</p>
        {hypothesis.engineerAnchoredAt ? (
          <p className={styles.text}>
            <Badge tone="neutral" size="sm" icon={<AnchorIcon />}>
              Anchored
            </Badge>{' '}
            The engineer committed to this explanation at{' '}
            {formatDateTimeUtc(hypothesis.engineerAnchoredAt)}, by a statement or an action.
          </p>
        ) : null}
      </div>

      <Accordion>
        <AccordionItem title="Confidence" defaultOpen>
          <div className={styles.section}>
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
          </div>
        </AccordionItem>

        <AccordionItem title="Why it is where it is" defaultOpen>
          <div className={styles.section}>
            {reason ? (
              <p className={styles.text}>
                <TruncatedText text={reason} limit={240} />
              </p>
            ) : (
              <p className={styles.text}>No evidence has moved this cause yet.</p>
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
              <Accordion>
                <AccordionItem
                  title={`Full confidence history (${hypothesis.timeline.length} points)`}
                  headingLevel={4}
                >
                  <DataTable
                    caption={`Confidence history of ${hypothesis.name}`}
                    columns={historyColumns}
                    rows={hypothesis.timeline}
                    getRowId={(p) => `${p.at}-${p.eventId}`}
                    dense
                  />
                </AccordionItem>
              </Accordion>
            ) : null}
          </div>
        </AccordionItem>

        <AccordionItem
          title={`Evidence that supports it (${evidence.supporting.length})`}
          defaultOpen
        >
          <EvidenceGroup
            intro="Strongest effect on the confidence first. Every item links to the event it came from."
            items={evidence.supporting}
            caseId={caseId}
            empty="No evidence on record supports this cause at this time."
          />
        </AccordionItem>

        <AccordionItem
          title={`Evidence that contradicts it (${evidence.contradicting.length})`}
          defaultOpen={evidence.contradicting.length > 0}
        >
          <EvidenceGroup
            intro="Contradictions are kept visible, not averaged away."
            items={evidence.contradicting}
            caseId={caseId}
            empty="Nothing on record contradicts this cause at this time."
          />
        </AccordionItem>

        <AccordionItem
          title={`Missing evidence (${missing.open.length})`}
          defaultOpen={missing.open.length > 0}
        >
          <div className={styles.section}>
            <p className={styles.muted}>
              What the knowledge pack says is needed to confirm or rule this cause in or out.
            </p>
            {missing.open.length === 0 ? (
              <p className={styles.text}>Nothing is missing for this cause at this time.</p>
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
          </div>
        </AccordionItem>

        <AccordionItem title={`Assumptions (${hypothesis.assumptions.length})`}>
          {hypothesis.assumptions.length === 0 ? (
            <p className={styles.text}>This cause relies on no stated assumptions.</p>
          ) : (
            <ul className={styles.bullets}>
              {hypothesis.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          )}
        </AccordionItem>

        <AccordionItem title="Cheapest safe validating action" defaultOpen>
          <div className={styles.section}>
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
                <div>
                  <button type="button" className={styles.linkButton} onClick={onShowRanking}>
                    See where it ranks among all candidate actions
                  </button>
                </div>
              </>
            ) : (
              <p className={styles.text}>
                {hypothesis.currentStatus === 'confirmed' ||
                hypothesis.currentStatus === 'ruled_out'
                  ? 'Nothing more needs testing: this cause is already settled on the evidence.'
                  : 'No safe validating action is suggested at this time.'}
              </p>
            )}
          </div>
        </AccordionItem>
      </Accordion>
    </>
  );
}
