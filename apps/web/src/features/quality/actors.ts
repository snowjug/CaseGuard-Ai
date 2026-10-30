'use client';

import { useCallback } from 'react';
import { useSession } from '../../lib/auth/session';

/**
 * Names the person behind an id the API recorded: "you" for the signed-in user, otherwise the id exactly as recorded
 * (the API exposes no directory of people to every role, and these pages never rank or profile anyone).
 */
export function useActorLabel(): (id: string | null | undefined) => string {
  const { session } = useSession();
  const me = session?.user.id ?? null;
  return useCallback((id) => (!id ? 'someone' : id === me ? 'you' : id), [me]);
}

/** The signed-in user's id, or null while it is loading. */
export function useCurrentUserId(): string | null {
  const { session } = useSession();
  return session?.user.id ?? null;
}
