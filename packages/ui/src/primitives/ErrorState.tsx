'use client';

import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowClockwiseRegular, ErrorCircleRegular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import { cg } from '../tokens/cg';
import { CopyButton } from './CopyButton';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[3],
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    color: cg.text,
  },
  compact: { padding: cg.space[3] },
  icon: { flexShrink: 0, display: 'inline-flex', fontSize: '24px', color: cg.tone.unsupported.fg },
  body: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  description: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  facts: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
  },
  mono: { fontFamily: cg.font.mono },
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2], marginTop: cg.space[1] },
});

export interface ErrorStateError {
  status?: number;
  /** Stable machine code, for example `forbidden` or `network_error`. */
  code?: string;
  /** Correlation id that support can search in the logs. */
  correlationId?: string;
}

export interface ErrorStateProps {
  /** Short headline. Defaults to "Something went wrong". */
  title?: string;
  /** What happened and what the person can do. Never a stack trace. */
  description?: ReactNode;
  /** Structured details (code, HTTP status, correlation id) shown in a muted line. */
  error?: ErrorStateError | null;
  /** When provided a Retry button is shown. */
  onRetry?: () => void;
  /** True while a retry is in flight (disables the button and sets `aria-busy`). */
  retrying?: boolean;
  retryLabel?: string;
  /** Extra actions, for example "Choose a development persona". */
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
}

/**
 * Error panel announced to assistive technology (`role="alert"`): headline, explanation, optional code and
 * correlation id (copyable), and a Retry button.
 */
export function ErrorState({
  title = 'Something went wrong',
  description,
  error,
  onRetry,
  retrying = false,
  retryLabel = 'Retry',
  actions,
  compact = false,
  className,
}: ErrorStateProps) {
  const styles = useStyles();
  const t = cg.tone.unsupported;
  return (
    <div
      role="alert"
      className={mergeClasses(styles.root, compact && styles.compact, className)}
      style={{ backgroundColor: t.tint, border: `1px solid ${t.border}` }}
    >
      <span aria-hidden="true" className={styles.icon}>
        <ErrorCircleRegular />
      </span>
      <div className={styles.body}>
        <h2 className={styles.title}>{title}</h2>
        {description ? <p className={styles.description}>{description}</p> : null}
        {error && (error.code || error.status || error.correlationId) ? (
          <p className={styles.facts}>
            {error.status ? <span>HTTP {error.status}</span> : null}
            {error.code ? (
              <span>
                Code <span className={styles.mono}>{error.code}</span>
              </span>
            ) : null}
            {error.correlationId ? (
              <span>
                Correlation ID <span className={styles.mono}>{error.correlationId}</span>
                <CopyButton value={error.correlationId} label="Copy correlation ID" />
              </span>
            ) : null}
          </p>
        ) : null}
        {onRetry || actions ? (
          <div className={styles.actions}>
            {onRetry ? (
              <Button
                appearance="primary"
                icon={<ArrowClockwiseRegular />}
                onClick={onRetry}
                disabled={retrying}
                aria-busy={retrying || undefined}
              >
                {retrying ? 'Retrying…' : retryLabel}
              </Button>
            ) : null}
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
