'use client';

import {
  PENALTY_LABELS,
  type AppliedPenalty,
  type Improvement,
  type QualityAssessment,
} from '@caseguard/schemas';
import {
  AnimatedList,
  Badge,
  Button,
  EmptyState,
  Panel,
  StatusBadge,
  UiLink,
  cg,
  formatNumber,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowRightIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  MinusIcon,
  ShieldCheckIcon,
  TrendingUpIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { evidenceLinkHref } from '../../lib/deep-links';
import { PRIORITY_BADGES } from '../../lib/labels';
import { ClampedText } from './ClampedText';
import { EvidenceLinkList } from './EvidenceLinkList';
import { useLook } from './look';
import { DIMENSION_COPY } from './quality-model';

/** Items shown before "Show all": the lists answer "what matters most", so they open short. */
const SHORT = 3;

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0 },
  item: {
    paddingBlock: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
    ':first-child': { borderTop: 0, paddingTop: 0 },
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: `${cg.space[1]} ${cg.space[3]}`,
  },
  headTitle: { flex: '1 1 auto', minWidth: 0 },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    alignSelf: 'flex-start',
    minHeight: '24px',
    color: cg.textLink,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  more: { alignSelf: 'flex-start', marginTop: cg.space[1] },
  moreIcon: { transitionProperty: 'transform', transitionDuration: cg.motion.base },
  moreOpen: { transform: 'rotate(180deg)' },
});

const num = (value: number, digits = 0): string =>
  formatNumber(value, { maximumFractionDigits: digits });

/** A list that opens at its first few items and says how many more there are. */
function ShortList<T>({
  items,
  getKey,
  renderItem,
  label,
}: {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  label: string;
}) {
  const styles = useStyles();
  const id = useId();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHORT);
  return (
    <>
      <div id={id}>
        <AnimatedList
          items={shown}
          getKey={getKey}
          renderItem={renderItem}
          aria-label={label}
          className={styles.list}
          itemClassName={styles.item}
        />
      </div>
      {items.length > SHORT ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.more}
          aria-expanded={all}
          aria-controls={id}
          icon={
            <ChevronDownIcon className={mergeClasses(styles.moreIcon, all && styles.moreOpen)} />
          }
          onClick={() => setAll((value) => !value)}
        >
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </Button>
      ) : null}
    </>
  );
}

function PenaltyItem({ penalty, caseId }: { penalty: AppliedPenalty; caseId: string }) {
  const styles = useStyles();
  const look = useLook();
  return (
    <div className={look.tight}>
      <div className={styles.head}>
        <h3 className={mergeClasses(look.title, styles.headTitle)}>
          {PENALTY_LABELS[penalty.key]}
        </h3>
        <Badge tone="neutral" size="sm" icon={<MinusIcon />}>
          {`−${num(penalty.points, 1)} points`}
        </Badge>
      </div>
      {penalty.dimension ? (
        <p className={look.meta}>{DIMENSION_COPY[penalty.dimension].name}</p>
      ) : null}
      <ClampedText text={penalty.rationale} lines={2} label={`explanation of ${penalty.label}`} />
      <EvidenceLinkList
        caseId={caseId}
        links={penalty.evidence}
        label={`Evidence for ${penalty.label}`}
      />
    </div>
  );
}

/** "What lowered the score": the penalties that applied, each with the evidence it rests on. */
export function LoweredList({
  assessment,
  caseId,
}: {
  assessment: QualityAssessment;
  caseId: string;
}) {
  const look = useLook();
  const { penalties } = assessment;
  return (
    <Panel
      title="What lowered the score"
      description={
        penalties.length === 0
          ? 'Each deduction names the evidence it rests on.'
          : `${penalties.length} ${penalties.length === 1 ? 'penalty' : 'penalties'} took off ${num(assessment.totalPenaltyPoints, 1)} points in total${assessment.penaltyCapApplied ? '. A cap applies, so less than this total was taken off.' : '.'}`
      }
      help="Penalties are rule-based and linked to evidence. They are capped so that one failure cannot zero a case. Points here are on the 0 to 100 scale of the score; each area shows the same deduction on its own scale."
      className={look.fill}
    >
      {penalties.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<CircleCheckIcon />}
          title="No penalty applied"
          description="Nothing in what was known matched a penalty rule."
        />
      ) : (
        <ShortList
          items={penalties}
          getKey={(penalty) => penalty.id}
          renderItem={(penalty) => <PenaltyItem penalty={penalty} caseId={caseId} />}
          label="Penalties"
        />
      )}
    </Panel>
  );
}

function ImprovementItem({ item, caseId }: { item: Improvement; caseId: string }) {
  const styles = useStyles();
  const look = useLook();
  const priority = PRIORITY_BADGES[item.priority];
  return (
    <div className={look.tight}>
      <div className={styles.head}>
        <StatusBadge status={priority.status} label={priority.label} size="small" />
        <Badge
          tone="brand"
          size="sm"
          icon={<TrendingUpIcon />}
          dotted
          title={`Could add about ${num(item.expectedScoreGain, 1)} points (an estimate)`}
        >
          {`About +${num(item.expectedScoreGain, 1)} points`}
        </Badge>
      </div>
      <h3 className={look.title}>{item.title}</h3>
      <ClampedText text={item.description} lines={2} label={`description of ${item.title}`} />
      {item.linkedForkId ? (
        <UiLink
          href={evidenceLinkHref(caseId, { type: 'fork', id: item.linkedForkId })}
          className={styles.link}
        >
          Open the key decision behind this
          <ArrowRightIcon aria-hidden="true" />
        </UiLink>
      ) : null}
      <EvidenceLinkList
        caseId={caseId}
        links={item.evidence}
        label={`Evidence for ${item.title}`}
      />
    </div>
  );
}

/** "What would raise it": the changes that would add the most, most important first. */
export function RaiseList({
  assessment,
  caseId,
}: {
  assessment: QualityAssessment;
  caseId: string;
}) {
  const look = useLook();
  const { improvements } = assessment;
  return (
    <Panel
      title="What would raise it"
      description="The changes that would add the most, most important first."
      help="Improvements are constructive suggestions linked to the penalty or key decision they address. The gain is an estimate of the points the score could rise by."
      className={look.fill}
    >
      {improvements.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<ShieldCheckIcon />}
          title="No improvement to suggest"
          description="Nothing in what was known calls for a change."
        />
      ) : (
        <ShortList
          items={improvements}
          getKey={(item) => item.id}
          renderItem={(item) => <ImprovementItem item={item} caseId={caseId} />}
          label="Improvements"
        />
      )}
    </Panel>
  );
}
