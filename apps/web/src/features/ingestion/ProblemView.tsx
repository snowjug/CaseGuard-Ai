'use client';

import { CopyButton, VisuallyHidden, cg } from '@caseguard/ui';
import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ErrorCircleRegular, InfoRegular } from '@fluentui/react-icons';
import { LinkButton } from '../../components/common/LinkButton';
import type { IngestProblem } from './ingest-errors';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[3],
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.tone.unsupported.border}`,
    backgroundColor: cg.tone.unsupported.tint,
    color: cg.text,
  },
  rootInfo: {
    borderTopColor: cg.tone.evidence.border,
    borderRightColor: cg.tone.evidence.border,
    borderBottomColor: cg.tone.evidence.border,
    borderLeftColor: cg.tone.evidence.border,
    backgroundColor: cg.tone.evidence.tint,
  },
  icon: { flexShrink: 0, display: 'inline-flex', fontSize: '24px', color: cg.tone.unsupported.fg },
  iconInfo: { color: cg.tone.evidence.fg },
  body: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  statement: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  title: { margin: 0, fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, overflowWrap: 'anywhere' },
  advice: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  issues: {
    margin: 0,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    fontSize: tokens.fontSizeBase300,
  },
  path: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  meta: {
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: cg.space[1],
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2], marginTop: cg.space[1] },
});

export interface ProblemViewProps {
  problem: IngestProblem;
  /** Seconds left before the request may be repeated (rate limit); 0 when none. */
  retryIn: number;
  /** Repeats the failed request. Omitted when repeating cannot help. */
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
}

/** Where the person can go to resolve the problem: the case in the way, the list to watch, the setting to fix. */
function problemLinks(problem: IngestProblem): { href: string; label: string }[] {
  switch (problem.kind) {
    case 'reference_in_use':
      return [
        {
          href: problem.reference ? `/cases?q=${encodeURIComponent(problem.reference)}` : '/cases',
          label: 'Find that case in the Cases list',
        },
      ];
    case 'in_progress':
      return [{ href: '/cases', label: 'Open the Cases list' }];
    case 'redaction_incomplete':
      return [{ href: '/governance?tab=redaction', label: 'Open Governance > Redaction' }];
    default:
      return [];
  }
}

/**
 * An ingestion failure in plain language: what happened (with the API's own message and limits), what to do next, the
 * field-level issues with their paths, a countdown when the server rate-limited the request, and the correlation id.
 * A request that is merely still running is shown as a calm notice, not as an error.
 *
 * Only the statement of the problem is a live region, and it never changes while the problem is shown. The countdown in
 * the Try again button ticks outside it (inside, a screen reader would read the whole problem out again every second);
 * one static sentence announces the wait, and one announces that the wait is over.
 */
export function ProblemView({
  problem,
  retryIn,
  onRetry,
  retrying = false,
  retryLabel = 'Try again',
}: ProblemViewProps) {
  const styles = useStyles();
  const calm = problem.tone === 'info';
  const links = problemLinks(problem);
  const canRetry = onRetry !== undefined && problem.retryable;
  const waited = problem.retryAfterSeconds;
  return (
    <div className={mergeClasses(styles.root, calm && styles.rootInfo)}>
      <span aria-hidden="true" className={mergeClasses(styles.icon, calm && styles.iconInfo)}>
        {calm ? <InfoRegular /> : <ErrorCircleRegular />}
      </span>
      <div className={styles.body}>
        <div role={calm ? 'status' : 'alert'} className={styles.statement}>
          <h4 className={styles.title}>{problem.title}</h4>
          <p className={styles.text}>{problem.message}</p>
          <p className={styles.advice}>{problem.advice}</p>
          {problem.issues.length > 0 ? (
            <ul className={styles.issues} aria-label="Fields to fix">
              {problem.issues.map((issue, index) => (
                <li key={`${issue.path}-${index}`}>
                  <code className={styles.path}>{issue.path || 'payload'}</code>: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {problem.correlationId ? (
          <p className={styles.meta}>
            Support reference <code className={styles.path}>{problem.correlationId}</code>
            <CopyButton value={problem.correlationId} label="Copy support reference" />
          </p>
        ) : null}
        {canRetry && waited !== null ? (
          <VisuallyHidden role="status" aria-live="polite">
            {retryIn > 0
              ? `Try again in ${waited} ${waited === 1 ? 'second' : 'seconds'}.`
              : 'You can retry now.'}
          </VisuallyHidden>
        ) : null}
        {links.length > 0 || canRetry ? (
          <div className={styles.actions}>
            {canRetry ? (
              <Button appearance="primary" onClick={onRetry} disabled={retryIn > 0 || retrying}>
                {retryIn > 0 ? `${retryLabel} in ${retryIn} s` : retryLabel}
              </Button>
            ) : null}
            {links.map((link) => (
              <LinkButton key={link.href} href={link.href} appearance="outline">
                {link.label}
              </LinkButton>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
