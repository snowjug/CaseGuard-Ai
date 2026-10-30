'use client';

import type { ReactNode } from 'react';
import { publicEnv } from '../env';
import { DevPersonaAuthProvider } from './dev-persona';
import { EntraRoot } from './entra';

/** Chooses the identity strategy from `NEXT_PUBLIC_AUTH_MODE` (`dev` by default, `entra` for Microsoft Entra ID). */
export function AuthProviderRoot({ children }: { children: ReactNode }) {
  if (publicEnv.authMode === 'entra') return <EntraRoot>{children}</EntraRoot>;
  return <DevPersonaAuthProvider>{children}</DevPersonaAuthProvider>;
}
