'use client';

import { ROLE_LABELS } from '@caseguard/schemas';
import { ConfirmDialog, UiLink, cg } from '@caseguard/ui';
import {
  Button,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  ProgressBar,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowResetRegular,
  ArrowRightRegular,
  DismissRegular,
  NotepadRegular,
  PersonSwapRegular,
} from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { describeError } from '../../lib/api/errors';
import { useApiMutation } from '../../lib/api/hooks';
import { invalidateAll } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { GatedAction, useSession } from '../../lib/auth/session';
import { usePresentation, usePresenterStep } from '../../lib/presentation';
import { safeInternalHref } from '../../lib/safe-href';
import { useToast } from '../../lib/toast';

const useStyles = makeStyles({
  strip: {
    position: 'fixed',
    insetInline: 0,
    bottom: 0,
    zIndex: 20,
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${cg.space[2]} ${cg.space[4]}`,
    padding: `${cg.space[2]} ${cg.space[4]}`,
    backgroundColor: cg.surfaceRaised,
    borderTop: `3px solid ${cg.tone.brand.solid}`,
    boxShadow: cg.shadowHigh,
    color: cg.text,
  },
  progress: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: '132px',
    flexShrink: 0,
  },
  progressLabel: {
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    fontWeight: tokens.fontWeightSemibold,
  },
  step: { display: 'flex', flexDirection: 'column', flex: '1 1 280px', minWidth: 0 },
  stepTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase400 },
  stepText: {
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
    [`@media (max-width: 719px)`]: { display: 'none' },
  },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  go: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[2],
    minHeight: '36px',
    padding: `0 ${cg.space[4]}`,
    borderRadius: cg.radius.md,
    backgroundColor: cg.tone.brand.solid,
    color: cg.tone.brand.onSolid,
    fontWeight: tokens.fontWeightSemibold,
    textDecorationLine: 'none',
    ':hover': { filter: 'brightness(1.08)' },
  },
  goDisabled: { backgroundColor: cg.surfaceSunken, color: cg.textMuted, pointerEvents: 'none' },
  notes: {
    maxWidth: '420px',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    whiteSpace: 'pre-wrap',
  },
  persona: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
  status: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
    flex: '1 1 240px',
  },
});

/**
 * Presenter strip (presentation mode only): where the guided demo is, what to do next, the presenter notes, the role to
 * present as, and a guarded reset. It reads `demo.state`, which the API derives from real data; nothing is invented here.
 */
export function PresenterStrip() {
  const styles = useStyles();
  const { enabled, setEnabled } = usePresentation();
  const { query, steps, current, completed } = usePresenterStep();
  const { session, can } = useSession();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const reset = useApiMutation('demo.reset');

  if (!enabled) return null;

  const total = steps.length;
  const role = current ? ROLE_LABELS[current.persona] : null;
  const roleMatches = current ? (session?.user.roles ?? []).includes(current.persona) : true;
  const href = current ? safeInternalHref(current.route) : null;

  const resetButton = (
    <Button appearance="subtle" size="small" icon={<ArrowResetRegular />}>
      Reset demo
    </Button>
  );

  return (
    <section className={styles.strip} aria-label="Presenter strip">
      {query.isError ? (
        <p className={styles.status} role="status">
          The demo guide could not be loaded: {describeError(query.error)}
        </p>
      ) : total === 0 ? (
        <p className={styles.status} role="status">
          {query.isPending
            ? 'Loading the demo guide…'
            : 'No demo steps are available yet. Load the synthetic sample from Cases to begin.'}
        </p>
      ) : (
        <>
          <div className={styles.progress}>
            <span className={styles.progressLabel}>
              Demo guide · {completed} of {total} done
            </span>
            <ProgressBar
              value={completed}
              max={total}
              thickness="medium"
              aria-label={`Demo progress: ${completed} of ${total} steps complete`}
            />
          </div>
          {current ? (
            <>
              <div className={styles.step}>
                <span className={styles.stepTitle}>
                  Next: {current.title}
                  {role ? <span className={styles.persona}> · present as {role}</span> : null}
                </span>
                <span className={styles.stepText}>{current.description}</span>
              </div>
              <div className={styles.actions}>
                {!roleMatches && auth.dev ? (
                  <Tooltip
                    content={`This step is best shown as ${role}. Switch the development persona.`}
                    relationship="description"
                    withArrow
                  >
                    <Button
                      appearance="outline"
                      icon={<PersonSwapRegular />}
                      onClick={() => auth.dev?.openPicker()}
                    >
                      Switch persona
                    </Button>
                  </Tooltip>
                ) : null}
                {href ? (
                  <UiLink href={href} className={styles.go}>
                    {current.actionLabel}
                    <ArrowRightRegular aria-hidden="true" />
                  </UiLink>
                ) : (
                  <span className={mergeClasses(styles.go, styles.goDisabled)}>
                    {current.actionLabel}
                  </span>
                )}
                <Popover positioning="above-end" withArrow>
                  <PopoverTrigger disableButtonEnhancement>
                    <Button appearance="outline" icon={<NotepadRegular />}>
                      Presenter notes
                    </Button>
                  </PopoverTrigger>
                  <PopoverSurface aria-label={`Presenter notes: ${current.title}`}>
                    <p className={styles.notes}>{current.presenterNotes}</p>
                  </PopoverSurface>
                </Popover>
              </div>
            </>
          ) : (
            <p className={styles.status}>
              Every demo step is complete. Reset the demo to run the story again.
            </p>
          )}
        </>
      )}
      <div className={styles.actions}>
        {can('demo:manage') ? (
          <ConfirmDialog
            trigger={resetButton}
            title="Reset the demo data?"
            tone="danger"
            confirmLabel="Reset demo"
            onConfirm={async () => {
              await reset.mutateAsync({});
              await invalidateAll(queryClient, auth.identityKey);
              toast.success('Demo data reset');
            }}
          >
            This restores the synthetic sample to its starting state and clears demo progress. Cases
            you created yourself are not affected.
          </ConfirmDialog>
        ) : (
          <GatedAction permission="demo:manage">{resetButton}</GatedAction>
        )}
        <Button
          appearance="subtle"
          size="small"
          icon={<DismissRegular />}
          onClick={() => setEnabled(false)}
        >
          Exit presentation
        </Button>
      </div>
    </section>
  );
}
