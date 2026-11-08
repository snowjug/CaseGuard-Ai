'use client';

import type { SkillDetail, SkillTransitionOption } from '@caseguard/schemas';
import {
  BentoGrid,
  BentoItem,
  Badge,
  Button,
  EmptyState,
  KeyValueList,
  Panel,
  RelativeTime,
  cg,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { HistoryIcon } from 'lucide-react';
import { ExpandableText } from '../../components/case/ExpandableText';
import { useApiMutation } from '../../lib/api/hooks';
import { useToast } from '../../lib/toast';
import { useActorLabel } from '../quality/actors';
import { explainFailure, failureText, needsReload } from '../quality/failure';
import { GatedConfirm } from '../quality/GatedConfirm';
import { StatusPill } from './Hints';
import { SKILL_INVALIDATES } from './hooks';
import { LIFECYCLE_LABELS, LIFECYCLE_MEANING, isWithdrawn, presentApproval } from './labels';
import { useSkillStyles } from './styles';

const TRANSITION_HELP =
  'Each step shows whether you can take it now and, if not, why. A step needs the right role, an independent person where the rule says so (the four-eyes rule), and its gate: for example a passed full simulation test. Your decision is recorded with your name and reason, and the skill record is checked for changes so two people cannot overwrite each other.';

const EXPLANATION: Partial<Record<string, string>> = {
  published:
    'Publication makes the skill available for matching on every case. It is always a human decision and is recorded with your name.',
  deprecated:
    'A deprecated skill is no longer offered for new matches. Applications already recorded are kept.',
  retired: 'A retired skill is no longer used and cannot come back. Its history is kept.',
  draft:
    'Sends the skill back for changes. Earlier validations stop counting once the content changes.',
};

const useStyles = makeStyles({
  fill: { height: '100%', boxSizing: 'border-box' },
  timeline: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none' },
  event: {
    position: 'relative',
    display: 'flex',
    gap: cg.space[4],
    minWidth: 0,
    paddingBottom: cg.space[6],
    ':last-child': { paddingBottom: 0 },
  },
  rail: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flexShrink: 0,
    width: '12px',
  },
  dot: {
    width: '12px',
    height: '12px',
    marginTop: cg.space[1],
    borderRadius: cg.radius.pill,
    backgroundColor: cg.tone.brand.solid,
    boxShadow: `0 0 0 3px ${cg.tone.brand.tint}`,
    flexShrink: 0,
  },
  dotQuiet: { backgroundColor: cg.borderControl, boxShadow: `0 0 0 3px ${cg.surfaceSunken}` },
  line: {
    flex: '1 1 auto',
    width: '2px',
    marginTop: cg.space[1],
    backgroundColor: `color-mix(in srgb, ${cg.text} 20%, transparent)`,
  },
  eventBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    flex: '1 1 auto',
  },
  step: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  stepTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
  },
  why: { color: cg.tone.uncertain.fg },
});

function TransitionCard({
  detail,
  option,
  onReload,
}: {
  detail: SkillDetail;
  option: SkillTransitionOption;
  onReload: () => void;
}) {
  const styles = useSkillStyles();
  const own = useStyles();
  const toast = useToast();
  const transition = useApiMutation('skills.transition', { invalidate: SKILL_INVALIDATES });
  const { skill } = detail;
  const target = LIFECYCLE_LABELS[option.toState];
  const withdraw = isWithdrawn(option.toState);
  const blocked = option.allowed
    ? null
    : (option.reason ?? 'This step is not available to you right now.');
  return (
    <li className={styles.rowItem}>
      <div className={styles.spread}>
        <div className={styles.rowHead}>
          <h3 className={own.stepTitle}>Move to {target}</h3>
          {option.allowed ? (
            <StatusPill status="productive" label="Available to you" />
          ) : (
            <StatusPill status="uncertain" label="Not available" />
          )}
          {option.requiresDistinctApprover ? (
            <Badge tone="neutral" size="sm">
              Needs a different person
            </Badge>
          ) : null}
        </div>
        <GatedConfirm
          permission="skill:review"
          blockedReason={blocked}
          trigger={
            <Button variant="secondary">
              {withdraw ? `Withdraw: ${target}` : `Move to ${target}`}
            </Button>
          }
          title={
            withdraw
              ? `${target === 'Retired' ? 'Retire' : 'Deprecate'} this skill?`
              : `Move this skill to ${target}?`
          }
          confirmLabel={withdraw ? `Withdraw as ${target}` : `Move to ${target}`}
          tone={withdraw ? 'danger' : 'default'}
          reason={{
            label: 'Reason (kept with the approval record)',
            minLength: 5,
            maxLength: 1000,
          }}
          onConfirm={async (reason) => {
            try {
              await transition.mutateAsync({
                params: { skillId: skill.id },
                body: { toState: option.toState, reason, expectedVersion: skill.version },
              });
              toast.success(
                option.toState === 'published' ? 'Skill published' : `Skill moved to ${target}`,
                {
                  body:
                    option.toState === 'published'
                      ? 'It is now live for matching. The decision is recorded with your name.'
                      : 'The decision is recorded with your name and reason.',
                },
              );
            } catch (error) {
              const failure = explainFailure(error, { lifecycleStep: true });
              if (needsReload(failure)) onReload();
              throw new Error(failureText(failure), { cause: error });
            }
          }}
        >
          <p>
            {EXPLANATION[option.toState] ??
              `The skill moves from ${LIFECYCLE_LABELS[skill.lifecycle]} to ${target}.`}
          </p>
          <p>
            It is recorded with your name and the reason below. If someone changed the skill after
            you opened this page, nothing is applied and you are told.
          </p>
        </GatedConfirm>
      </div>
      <p className={styles.text}>{LIFECYCLE_MEANING[option.toState]}</p>
      {option.gate ? (
        <p className={styles.text}>
          <span className={styles.strong}>Gate:</span> {option.gate}
        </p>
      ) : null}
      {blocked ? (
        <p className={styles.text}>
          <span className={styles.strong}>Why not now:</span> {blocked}
        </p>
      ) : null}
      <p className={styles.meta}>Needs the {option.requiredPermission} permission.</p>
    </li>
  );
}

function ApprovalsPanel({ detail }: { detail: SkillDetail }) {
  const styles = useSkillStyles();
  const own = useStyles();
  const actor = useActorLabel();
  const versionOf = new Map(detail.versions.map((version) => [version.id, version.version]));
  const approvals = [...detail.approvals].sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : 1));
  return (
    <Panel
      title="Decisions so far"
      description="Every approval, change request and withdrawal, in order."
      help="Each row is one recorded decision with who made it, who it was for and the reason they gave. A skill that was withdrawn (deprecated or retired) is shown as withdrawn, not as rejected: withdrawing only reduces what the skill can do."
    >
      {approvals.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<HistoryIcon />}
          title="No decision recorded yet"
          description="The first step is for a person other than the one who extracted the skill to adopt it as a draft."
        />
      ) : (
        <ol className={own.timeline} aria-label="Decisions in order">
          {approvals.map((approval, index) => {
            const view = presentApproval(approval);
            const last = index === approvals.length - 1;
            return (
              <li key={approval.id} className={own.event}>
                <span className={own.rail} aria-hidden="true">
                  <span className={own.dot} />
                  {last ? null : <span className={own.line} />}
                </span>
                <div className={own.eventBody}>
                  <div className={styles.rowHead}>
                    <StatusPill status={view.status} label={view.label} />
                    <RelativeTime value={approval.decidedAt} className={styles.meta} />
                  </div>
                  <p className={styles.text}>{view.sentence(actor(approval.approver))}</p>
                  <p className={styles.meta}>
                    Requested by {actor(approval.requestedBy)} · version{' '}
                    {versionOf.get(approval.versionId) ?? approval.versionId}
                  </p>
                  <ExpandableText text={approval.reason} lines={3} label="reason" />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

function PeoplePanel({ detail }: { detail: SkillDetail }) {
  const own = useStyles();
  const actor = useActorLabel();
  const { skill, approvals } = detail;
  const pilotApprovers = [
    ...new Set(
      approvals
        .filter((approval) => approval.toState === 'pilot' && approval.decision === 'approved')
        .map((approval) => actor(approval.approver)),
    ),
  ];
  const publishers = [
    ...new Set(
      approvals
        .filter((approval) => approval.toState === 'published' && approval.decision === 'approved')
        .map((approval) => actor(approval.approver)),
    ),
  ];
  return (
    <Panel
      title="Who is involved"
      description="Approvals stay independent: the creator, the pilot approver and the publisher are different people."
      help="The four-eyes rule: whoever created a skill, or proposed a change to it, cannot approve it. Publication needs someone other than the creator and the pilot approver. People appear as their recorded ids; no figure on these pages rates or ranks anyone."
      className={own.fill}
    >
      <KeyValueList
        aria-label="People involved in this skill"
        layout="inline"
        items={[
          { id: 'creator', label: 'Created by', value: actor(skill.createdBy) },
          { id: 'owner', label: 'Owner', value: actor(skill.owner) },
          {
            id: 'reviewer',
            label: 'Reviewer',
            value: skill.reviewer ? actor(skill.reviewer) : 'Not assigned yet',
          },
          {
            id: 'pilot',
            label: 'Pilot approved by',
            value: pilotApprovers.length > 0 ? pilotApprovers.join(', ') : 'No pilot approval yet',
          },
          {
            id: 'published',
            label: 'Published by',
            value: publishers.length > 0 ? publishers.join(', ') : 'Not published',
          },
        ]}
      />
    </Panel>
  );
}

export interface GovernanceTabProps {
  detail: SkillDetail;
  onReload: () => void;
}

/** The "Governance" tab: who is involved, the steps you can take (and why others are blocked) and the decisions so far. */
export function GovernanceTab({ detail, onReload }: GovernanceTabProps) {
  const styles = useSkillStyles();
  const own = useStyles();
  return (
    <div className={styles.page}>
      <BentoGrid>
        <BentoItem span={12} spanLg={5}>
          <PeoplePanel detail={detail} />
        </BentoItem>
        <BentoItem span={12} spanLg={7}>
          <Panel
            title="Next steps"
            description="What can happen to this skill next, and who may do it."
            help={TRANSITION_HELP}
            className={own.fill}
          >
            {detail.transitions.length === 0 ? (
              <p className={styles.text}>
                This skill has reached the end of its status path, so there is no further step.
              </p>
            ) : (
              <ul className={styles.rows}>
                {detail.transitions.map((option) => (
                  <TransitionCard
                    key={option.toState}
                    detail={detail}
                    option={option}
                    onReload={onReload}
                  />
                ))}
              </ul>
            )}
          </Panel>
        </BentoItem>
      </BentoGrid>
      <ApprovalsPanel detail={detail} />
    </div>
  );
}
