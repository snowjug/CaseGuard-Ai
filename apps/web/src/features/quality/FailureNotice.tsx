'use client';

import { Button, Notice } from '@caseguard/ui';
import { RotateCwIcon } from 'lucide-react';
import type { ExplainedFailure } from './failure';

export interface FailureNoticeProps {
  failure: ExplainedFailure;
  /** Offered for failures that trying again can fix (throttling, unreachable API). */
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * A failed action or panel read, in plain language: what happened, what to do next, and what the API itself said. A
 * throttled request shows how long the API asked us to wait.
 */
export function FailureNotice({ failure, onRetry, retrying = false }: FailureNoticeProps) {
  const retryable =
    failure.kind === 'throttled' || failure.kind === 'unavailable' || failure.kind === 'other';
  return (
    <div role="alert">
      <Notice
        variant="warning"
        title={failure.title}
        action={
          onRetry && retryable ? (
            <Button
              variant="secondary"
              icon={<RotateCwIcon />}
              disabled={retrying}
              loading={retrying}
              onClick={onRetry}
            >
              Try again
            </Button>
          ) : undefined
        }
      >
        {failure.message}
        {failure.apiDetail ? ` The API said: ${failure.apiDetail}` : null}
      </Notice>
    </div>
  );
}
