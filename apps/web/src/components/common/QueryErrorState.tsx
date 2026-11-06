'use client';

import { Button, ErrorState, type ErrorStateProps } from '@caseguard/ui';
import { LogInIcon, UserRoundCogIcon } from 'lucide-react';
import { describeError, isApiError } from '../../lib/api/errors';
import { useAuth } from '../../lib/auth/context';

export interface QueryErrorStateProps {
  /** The error from a query or mutation (an `ApiError` in practice). */
  error: unknown;
  /** Shown as the Retry button's action. Omitted for errors that retrying cannot fix (403). */
  onRetry?: () => void;
  retrying?: boolean;
  /** What failed, as a noun phrase: "The Command Center". Used in the headline. */
  subject?: string;
  compact?: boolean;
}

/**
 * The standard error state for a failed API call: plain-language headline and explanation, status, code and
 * correlation id for support, a Retry button, and the right next step for sign-in problems (choose a persona in
 * development, sign in with Entra otherwise). Use it for every `useApiQuery` error.
 */
export function QueryErrorState({
  error,
  onRetry,
  retrying,
  subject = 'This page',
  compact,
}: QueryErrorStateProps) {
  const auth = useAuth();
  const api = isApiError(error) ? error : null;
  const needsIdentity = api?.isUnauthenticated === true || auth.status === 'unauthenticated';

  let title = `${subject} could not be loaded`;
  if (needsIdentity) title = 'Choose an identity to continue';
  else if (api?.isMisconfigured) title = 'The CaseGuard API is not configured';
  else if (api?.isNetwork || api?.isUnavailable) title = 'The CaseGuard API is not reachable';
  else if (api?.isForbidden) title = 'You do not have access to this';
  else if (api?.isTimeout) title = 'The API took too long to answer';

  const props: ErrorStateProps = {
    title,
    description: needsIdentity
      ? 'This view is tied to a role. Choose who you are acting as, then it will load.'
      : describeError(error),
    compact: compact ?? false,
    retrying: retrying ?? false,
  };
  if (api) {
    props.error = {
      status: api.status,
      code: api.code,
      ...(api.correlationId ? { correlationId: api.correlationId } : {}),
    };
  }
  if (onRetry && !api?.isForbidden && !needsIdentity) props.onRetry = onRetry;
  if (needsIdentity && auth.dev) {
    props.actions = (
      <Button variant="primary" icon={<UserRoundCogIcon />} onClick={() => auth.dev?.openPicker()}>
        Choose a development persona
      </Button>
    );
  } else if (needsIdentity && auth.signIn) {
    props.actions = (
      <Button variant="primary" icon={<LogInIcon />} onClick={() => void auth.signIn?.()}>
        Sign in
      </Button>
    );
  }
  return <ErrorState {...props} />;
}
