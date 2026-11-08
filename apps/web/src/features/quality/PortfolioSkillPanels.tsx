'use client';

import { SYNTHETIC_EFFECTIVENESS_NOTICE, type AnalyticsOverview } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  DataTable,
  EmptyState,
  Panel,
  ProvenanceBadge,
  StackedBar,
  UiLink,
  cg,
  type DataTableColumn,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { DnaIcon } from 'lucide-react';
import { formatNumber, formatPercent } from '../../lib/format';
import { useLook } from './look';
import { optionalRate, timeBasisText, timeDeltaText } from './portfolio-model';

type EffectivenessRow = AnalyticsOverview['skillEffectiveness'][number];

const TIME_BASIS_NOTE =
  'Time to diagnosis is compared with the recorded path of the case each skill came from where there is one: the same kind of figure, but a different case and no control group. Otherwise it is compared with a simulated baseline that has no waiting between steps, so recorded times read longer than it by construction.';

const useStyles = makeStyles({
  fill: { height: '100%', boxSizing: 'border-box' },
  figures: {
    display: 'grid',
    gap: `${cg.space[4]} ${cg.space[6]}`,
    gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))',
    margin: 0,
  },
  figure: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0, margin: 0 },
  figureValue: {
    margin: 0,
    fontSize: tokens.fontSizeBase600,
    lineHeight: tokens.lineHeightBase600,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  figureLabel: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textSecondary,
  },
  // The name comes first for a screen reader; the number is shown first.
  first: { order: 1 },
  second: { order: 2 },
  third: { order: 3 },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    color: cg.textLink,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    textDecorationLine: 'none',
    overflowWrap: 'anywhere',
    ':hover': { textDecorationLine: 'underline' },
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  cell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: cg.space[1],
    minWidth: 0,
  },
  cellBadges: { display: 'flex', flexWrap: 'wrap', gap: cg.space[1] },
  rate: { display: 'flex', alignItems: 'baseline', gap: cg.space[2] },
});

interface Figure {
  label: string;
  value: string;
  note?: string;
}

/** A few big numbers with their names: plain text on the card, no box of their own. */
function Figures({ items, label }: { items: readonly Figure[]; label: string }) {
  const styles = useStyles();
  const look = useLook();
  return (
    <dl className={styles.figures} aria-label={label}>
      {items.map((item) => (
        <div key={item.label} className={styles.figure}>
          <dt className={mergeClasses(styles.figureLabel, styles.second)}>{item.label}</dt>
          <dd className={mergeClasses(styles.figureValue, styles.first)}>{item.value}</dd>
          {item.note ? (
            <dd className={mergeClasses(look.meta, styles.third)}>{item.note}</dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

const count = (value: number): string => formatNumber(value, { maximumFractionDigits: 0 });

function SkillLink({ id, name }: { id: string; name: string }) {
  const styles = useStyles();
  return (
    <UiLink href={`/skills/${encodeURIComponent(id)}`} className={styles.link}>
      {name}
    </UiLink>
  );
}

/**
 * The change in time to diagnosis with what it is compared with named under it (the basis changes what the figure
 * means), then the labels of the figure. They sit in the cell rather than in a column of their own: a column that only
 * holds badges is squeezed to a few pixels on a phone, and a label cut to "Esti…" labels nothing.
 */
function TimeCell({ row }: { row: EffectivenessRow }) {
  const styles = useStyles();
  const look = useLook();
  const delta = row.timeToDiagnosisDeltaPct;
  const basis = delta === null ? null : timeBasisText(row.timeToDiagnosisBasis);
  return (
    <div className={styles.cell}>
      <span>{timeDeltaText(delta, row.timeToDiagnosisBasis)}</span>
      {basis ? <span className={look.meta}>{basis}</span> : null}
      {delta !== null || row.synthetic ? (
        <span className={styles.cellBadges}>
          {delta !== null ? <ProvenanceBadge kind="estimated" size="small" /> : null}
          {row.synthetic ? <ProvenanceBadge kind="synthetic" size="small" /> : null}
        </span>
      ) : null}
    </div>
  );
}

const EFFECTIVENESS_COLUMNS: readonly DataTableColumn<EffectivenessRow>[] = [
  {
    id: 'skill',
    header: 'Skill',
    rowHeader: true,
    cell: (row) => <SkillLink id={row.skillId} name={row.name} />,
    sortValue: (row) => row.name,
  },
  {
    id: 'applications',
    header: 'Times applied',
    align: 'end',
    cell: (row) => count(row.applications),
    sortValue: (row) => row.applications,
  },
  {
    id: 'delta',
    header: 'Time to diagnosis',
    cell: (row) => <TimeCell row={row} />,
    sortValue: (row) => row.timeToDiagnosisDeltaPct,
  },
];

export function SkillsPanel({
  adoption,
  effectiveness,
}: {
  adoption: AnalyticsOverview['skillAdoption'];
  effectiveness: AnalyticsOverview['skillEffectiveness'];
}) {
  const styles = useStyles();
  const look = useLook();
  const anySynthetic = effectiveness.some((row) => row.synthetic);
  return (
    <Panel
      title="Skills in use"
      description="How many reusable fixes exist, where they were matched and applied, and what that did to time to diagnosis."
      help="Adoption counts skills by status and the cases they matched or were applied to. Effectiveness compares time to diagnosis, for each skill that has been applied, with the recorded path of the case the skill came from where there is one, and otherwise with a simulated baseline. These are estimates from very few applications: treat them as a demonstration of the measurement, not as proof that a skill works."
      className={styles.fill}
    >
      {adoption.totalSkills === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<DnaIcon />}
          title="No skills yet"
          description="A skill is extracted from an accepted better path and then governed through review, pilot and publication."
        />
      ) : (
        <Figures
          label="Skills in use"
          items={[
            { label: 'Skills', value: count(adoption.totalSkills) },
            { label: 'Published', value: count(adoption.published) },
            { label: 'Pilot or validated', value: count(adoption.pilotOrValidated) },
            { label: 'Cases matched', value: count(adoption.matchedCases) },
            { label: 'Cases where applied', value: count(adoption.appliedCases) },
          ]}
        />
      )}
      {effectiveness.length > 0 ? (
        <Accordion>
          <AccordionItem
            title="Show results by skill"
            subtitle="Time to diagnosis for each skill that was applied"
          >
            <div className={look.stack}>
              <DataTable
                caption="Results by skill"
                columns={EFFECTIVENESS_COLUMNS}
                rows={effectiveness}
                getRowId={(row) => row.skillId}
                dense
              />
              {effectiveness.some((row) => row.timeToDiagnosisBasis) ? (
                <p className={look.meta}>{TIME_BASIS_NOTE}</p>
              ) : null}
              {anySynthetic ? <p className={look.meta}>{SYNTHETIC_EFFECTIVENESS_NOTICE}</p> : null}
            </div>
          </AccordionItem>
        </Accordion>
      ) : adoption.totalSkills > 0 ? (
        <p className={look.text}>
          No skill has been applied to a case yet, so there are no results to show.
        </p>
      ) : null}
    </Panel>
  );
}

export function TokenPanel({ tokens: figures }: { tokens: AnalyticsOverview['tokenEfficiency'] }) {
  const styles = useStyles();
  return (
    <Panel
      title="Analysis usage"
      description="Information gained per token, and estimated savings from a simulated better path."
      help="Bits per 1,000 tokens is the information the analysis gained from hypothesis updates for every thousand tokens used; the saving compares the real path with a simulated one. Both are estimates, and the token counts come from the deterministic provider's synthetic telemetry."
      className={styles.fill}
      actions={
        <>
          <ProvenanceBadge kind="estimated" />
          <ProvenanceBadge kind="simulated" />
        </>
      }
      footer={
        <UiLink href="/efficiency" className={styles.link}>
          Open usage and cost
        </UiLink>
      }
    >
      <Figures
        label="Analysis usage"
        items={[
          {
            label: 'Information per 1,000 tokens',
            value:
              figures.avgBitsPer1kTokens === null
                ? 'Not enough data'
                : `${formatNumber(figures.avgBitsPer1kTokens, { maximumFractionDigits: 2 })} bits`,
            note: 'Average over analysed cases',
          },
          {
            label: 'Estimated token saving',
            value:
              figures.avgEstimatedSavingsPct === null
                ? 'Not enough data'
                : formatPercent(figures.avgEstimatedSavingsPct, 1),
            note: 'Real path versus simulated path',
          },
        ]}
      />
    </Panel>
  );
}

export function AcceptancePanel({
  acceptance,
}: {
  acceptance: AnalyticsOverview['counterfactualAcceptance'];
}) {
  const styles = useStyles();
  const look = useLook();
  return (
    <Panel
      title="Better paths reviewers accepted"
      description="How often a reviewer accepted a simulated better path."
      help="Reviewers accept or reject each simulated path with a reason. A low rate can mean the simulations need work; it says nothing about the people who ran or reviewed them."
      className={styles.fill}
    >
      {acceptance.reviewed === 0 ? (
        <p className={look.text}>No simulated path has been reviewed yet, so there is no rate.</p>
      ) : (
        <>
          <p className={styles.rate}>
            <span className={styles.figureValue}>
              {optionalRate(acceptance.rate, 'No rate yet')}
            </span>
            <span className={look.meta}>accepted</span>
          </p>
          <StackedBar
            title="Reviewed simulated paths"
            valueLabel="Paths"
            valueFormat={(value) => formatNumber(value, { maximumFractionDigits: 0 })}
            segments={[
              {
                key: 'accepted',
                label: 'Accepted',
                value: acceptance.accepted,
                tone: 'productive',
              },
              {
                key: 'rejected',
                label: 'Rejected',
                value: acceptance.rejected,
                tone: 'unsupported',
              },
            ]}
          />
          <p className={look.meta}>
            {acceptance.accepted} accepted and {acceptance.rejected} rejected out of{' '}
            {acceptance.reviewed} reviewed.
          </p>
        </>
      )}
    </Panel>
  );
}

export function DisagreementPanel({
  disagreement,
}: {
  disagreement: AnalyticsOverview['reviewerDisagreement'];
}) {
  const styles = useStyles();
  const look = useLook();
  return (
    <Panel
      title="Reviewer corrections"
      description="How often a reviewer changed the evidence category the analysis proposed."
      help="A correction means a reviewer chose a different evidence category from the one the analysis proposed. It measures how often the classifier needs help. It is never a measure of how any person performs."
      className={styles.fill}
    >
      {disagreement.reviewedClaims === 0 ? (
        <p className={look.text}>No claim has been reviewed yet, so there is no rate.</p>
      ) : (
        <>
          <p className={styles.rate}>
            <span className={styles.figureValue}>
              {optionalRate(disagreement.rate, 'No rate yet')}
            </span>
            <span className={look.meta}>corrected</span>
          </p>
          <p className={look.meta}>
            {disagreement.corrected} of {disagreement.reviewedClaims} reviewed claims were
            corrected.
          </p>
        </>
      )}
    </Panel>
  );
}

export function PrivacyPanel({
  notes,
  responsibleUse,
}: {
  notes: readonly string[];
  responsibleUse: string;
}) {
  const styles = useStyles();
  const look = useLook();
  return (
    <Panel
      title="Privacy and how to read this page"
      description="What is shown, what is never shown, and how far to trust it."
      className={styles.fill}
    >
      <p className={look.text}>{responsibleUse}</p>
      <ul className={look.bullets}>
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </Panel>
  );
}
