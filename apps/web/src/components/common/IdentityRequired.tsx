'use client';

import { Button, Card, LoadingSkeleton, Logo, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { LogInIcon, UserRoundCogIcon } from 'lucide-react';
import { useId } from 'react';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { PersonaList } from '../../lib/auth/dev-persona';
import { FlowSteps } from './FlowSteps';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', gap: cg.space[6] },
  promise: {
    margin: 0,
    maxWidth: '22ch',
    color: cg.text,
    fontSize: tokens.fontSizeHero800,
    lineHeight: tokens.lineHeightHero800,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.03em',
    '@media (max-width: 639px)': {
      fontSize: tokens.fontSizeHero700,
      lineHeight: tokens.lineHeightHero700,
    },
  },
  lead: { margin: 0, maxWidth: '56ch', color: cg.textSecondary, fontSize: tokens.fontSizeBase400 },
  who: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  title: {
    margin: 0,
    color: cg.text,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
  },
  note: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  personas: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: cg.space[2],
    '@media (min-width: 900px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[3] },
});

/**
 * Shown instead of page data when nobody is signed in yet. It is a first visit, not an error: it says what the product
 * does and what happens next. In development the person picks one of the synthetic personas right here (one click);
 * with Entra ID they sign in.
 */
export function IdentityRequired() {
  const styles = useStyles();
  const auth = useAuth();
  const titleId = useId();
  const dev = auth.dev;
  const personas = useApiQuery('dev.personas', undefined, {
    enabled: dev !== undefined,
    staleTime: 5 * 60_000,
  });
  const choices = dev && personas.data?.enabled ? personas.data.items : null;

  return (
    <Card as="section" hero glow padding="lg" className={styles.card} aria-labelledby={titleId}>
      <Logo size={32} />
      <p className={styles.promise}>See how a support case went and what to fix first.</p>
      <p className={styles.lead}>
        CaseGuard AI scores a case, explains the score and lists the top fixes, with the evidence
        behind each one.
      </p>
      <FlowSteps stage={1} />
      <div className={styles.who}>
        <h2 id={titleId} className={styles.title}>
          {dev ? 'Choose who you are acting as' : 'Sign in to continue'}
        </h2>
        <p className={styles.note}>
          {dev
            ? 'These are demo identities. Your role decides what you can see and do; this is not real sign-in.'
            : 'Sign in with your work account to see the cases and quality analysis you have access to.'}
        </p>
        {dev && personas.isPending ? (
          <LoadingSkeleton variant="list" count={3} label="Loading the demo identities" />
        ) : null}
        {choices ? (
          <PersonaList
            className={styles.personas}
            personas={choices}
            chosenId={dev?.personaId ?? null}
            onSelect={(id) => dev?.selectPersona(id)}
            showTenant={false}
          />
        ) : null}
        {dev && !personas.isPending && !choices ? (
          <div className={styles.actions}>
            <Button variant="primary" icon={<UserRoundCogIcon />} onClick={() => dev.openPicker()}>
              Choose a development persona
            </Button>
          </div>
        ) : null}
        {!dev && auth.signIn ? (
          <div className={styles.actions}>
            <Button variant="primary" icon={<LogInIcon />} onClick={() => void auth.signIn?.()}>
              Sign in
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
