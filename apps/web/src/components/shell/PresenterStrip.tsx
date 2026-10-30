'use client';

import { ROLE_LABELS } from '@caseguard/schemas';
import { ConfirmDialog, UiLink, cg, useElementSize } from '@caseguard/ui';
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
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { describeError } from '../../lib/api/errors';
import { useApiMutation } from '../../lib/api/hooks';
import { invalidateAll } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { GatedAction, useSession } from '../../lib/auth/session';
import { usePresentation, usePresenterStep } from '../../lib/presentation';
import { explainDemoError } from '../../lib/presentation/demo-errors';
import { PRESENTER_HEIGHT_VAR } from '../../lib/presentation/presenter-height';
import { useRoleSwitch } from '../../lib/presentation/use-role-switch';
import { safeInternalHref } from '../../lib/safe-href';
import { useToast } from '../../lib/toast';

export { PRESENTER_HEIGHT_VAR };

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
    margin: 0,
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
 * Presenter strip (presentation mode only): where the guided demo is, what to do next, the role to present as, the
 * presenter notes, and a guarded reset. It reads `demo.state`, which the API derives from stored data; nothing is
 * invented here. The next action is outlined with the pulsing (reduced-motion safe) presenter outline, a persona of the
 * right role is one click away, and after a reset the presenter lands on the Demo Guide because every case page is gone.
 */
export function PresenterStrip() {
  const styles = useStyles();
  const router = useRouter();
  const { enabled, setEnabled } = usePresentation();
  const { query, steps, current, completed } = usePresenterStep();
  const { can } = useSession();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const roleSwitch = useRoleSwitch({ enabled });
  const reset = useApiMutation('demo.reset');
  const [measure, size] = useElementSize<HTMLElement>({ width: 0, height: 104 });

  // The strip is fixed to the bottom, so tell the page how tall it is (content padding and toasts follow).
  useEffect(() => {
    if (!enabled) return undefined;
    document.documentElement.style.setProperty(PRESENTER_HEIGHT_VAR, `${size.height + 3}px`);
    return () => {
      document.documentElement.style.removeProperty(PRESENTER_HEIGHT_VAR);
    };
  }, [enabled, size.height]);

  if (!enabled) return null;

  const total = steps.length;
  const role = current ? ROLE_LABELS[current.persona] : null;
  const needsSwitch = current ? !roleSwitch.actingAs(current.persona) : false;
  const persona = current ? roleSwitch.personaFor(current.persona) : null;
  const href = current ? safeInternalHref(current.route) : null;

  const resetButton = (
    <Button appearance="subtle" size="small" icon={<ArrowResetRegular />}>
      Reset demo
    </Button>
  );

  return (
    <section ref={measure} className={styles.strip} aria-label="Presenter strip">
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
                  {completed === total ? 'Last step' : 'Next'}: {current.title}
                  {role ? <span className={styles.persona}> · present as {role}</span> : null}
                </span>
                <span className={styles.stepText}>{current.description}</span>
              </div>
              <div className={styles.actions}>
                {needsSwitch && auth.dev ? (
                  <Tooltip
                    content={`This step is shown as ${role}. Switch the synthetic persona to match.`}
                    relationship="description"
                    withArrow
                  >
                    <Button
                      appearance="outline"
                      icon={<PersonSwapRegular />}
                      {...(persona ? { 'aria-label': `Switch to ${persona.displayName}` } : {})}
                      onClick={() =>
                        persona ? roleSwitch.switchTo(persona) : auth.dev?.openPicker()
                      }
                    >
                      {persona
                        ? `Switch to ${persona.displayName.replace(/\s*\(synthetic\)\s*$/i, '')}`
                        : 'Switch persona'}
                    </Button>
                  </Tooltip>
                ) : null}
                {href ? (
                  <UiLink href={href} className={mergeClasses(styles.go, 'cg-presenter-target')}>
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
              try {
                await reset.mutateAsync({});
              } catch (error) {
                throw explainDemoError(error, 'The reset failed.');
              }
              await invalidateAll(queryClient, auth.identityKey);
              toast.success('Demo data reset');
              // Every case page of the story is gone now; the guide is where the presenter starts again.
              router.push('/demo');
            }}
          >
            This erases the cases, analysis results and skills of the synthetic demo tenant and
            clears demo progress. Users, settings and the audit trail are kept.
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
