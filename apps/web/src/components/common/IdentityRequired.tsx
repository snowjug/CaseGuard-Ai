'use client';

import { EmptyState } from '@caseguard/ui';
import { Button } from '@fluentui/react-components';
import { PersonSwapRegular, PersonRegular } from '@fluentui/react-icons';
import { useAuth } from '../../lib/auth/context';

/**
 * Shown instead of page data when nobody is signed in yet. It is a next step, not an error: in development the person
 * picks a synthetic persona; with Entra ID they sign in.
 */
export function IdentityRequired() {
  const auth = useAuth();
  const action = auth.dev ? (
    <Button
      appearance="primary"
      icon={<PersonSwapRegular />}
      onClick={() => auth.dev?.openPicker()}
    >
      Choose a development persona
    </Button>
  ) : auth.signIn ? (
    <Button appearance="primary" icon={<PersonRegular />} onClick={() => void auth.signIn?.()}>
      Sign in
    </Button>
  ) : undefined;
  return (
    <EmptyState
      headingLevel={2}
      icon={<PersonRegular />}
      title="Choose who you are acting as"
      description={
        auth.dev
          ? 'CaseGuard shows what your role is allowed to see. Pick one of the synthetic development personas to continue; this is not real sign-in.'
          : 'Sign in with your work account to see the cases and quality analysis you have access to.'
      }
      {...(action ? { action } : {})}
    />
  );
}
