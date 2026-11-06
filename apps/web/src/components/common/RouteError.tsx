'use client';

import { ErrorState, cg, useButtonClassName } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { HomeIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

const useStyles = makeStyles({
  standalone: { maxWidth: '720px', marginInline: 'auto', padding: `${cg.space[8]} ${cg.space[4]}` },
  focus: { outlineStyle: 'none' },
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
  const homeClass = useButtonClassName({ variant: 'secondary' });

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const body = (
    <div ref={heading} tabIndex={-1} className={styles.focus}>
      <ErrorState
        title="This page hit an unexpected problem"
        description="Nothing was lost or changed. You can try again, or start over from Home."
        error={{ code: 'render_error', ...(error.digest ? { correlationId: error.digest } : {}) }}
        onRetry={reset}
        actions={
          // A full page load on purpose: it clears whatever state caused the crash.
          <a href="/" className={homeClass}>
            <HomeIcon aria-hidden="true" />
            Go home
          </a>
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
