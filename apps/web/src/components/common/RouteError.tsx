'use client';

import { ErrorState, cg } from '@caseguard/ui';
import { Button, makeStyles } from '@fluentui/react-components';
import { HomeRegular } from '@fluentui/react-icons';
import { useEffect, useRef } from 'react';

const useStyles = makeStyles({
  standalone: { maxWidth: '720px', marginInline: 'auto', padding: `${cg.space[8]} ${cg.space[4]}` },
});

export interface RouteErrorProps {
  /** The error that Next.js passes to `error.tsx`; `digest` identifies the matching server log entry. */
  error: Error & { digest?: string };
  reset: () => void;
  /** Wrap in a `main` landmark (for error pages outside the application shell). */
  standalone?: boolean;
}

/** Body of `error.tsx`: a safe message (never the stack), the log digest, and a Retry that re-renders the segment. */
export function RouteError({ error, reset, standalone = false }: RouteErrorProps) {
  const styles = useStyles();
  const heading = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const body = (
    <div ref={heading} tabIndex={-1} style={{ outline: 'none' }}>
      <ErrorState
        title="This page hit an unexpected problem"
        description="Nothing was lost or changed. You can try again, or start over from the Command Center."
        error={{ code: 'render_error', ...(error.digest ? { correlationId: error.digest } : {}) }}
        onRetry={reset}
        actions={
          // A full page load on purpose: it clears whatever state caused the crash.
          <Button as="a" href="/" appearance="outline" icon={<HomeRegular />}>
            Go to the Command Center
          </Button>
        }
      />
    </div>
  );
  return standalone ? (
    <main id="main-content" className={styles.standalone}>
      {body}
    </main>
  ) : (
    body
  );
}
