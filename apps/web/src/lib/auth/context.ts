'use client';

import type { AuthMode } from '@caseguard/schemas';
import { createContext, useContext } from 'react';

export type AuthStatus = 'loading' | 'unauthenticated' | 'ready';

/** Development-identity controls, present only for `DevPersonaAuth`. */
export interface DevIdentityControls {
  /** The persona id that is sent as `x-cg-persona`, or null when none was chosen. */
  personaId: string | null;
  selectPersona: (personaId: string | null) => void;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
}

/** What every identity strategy (development persona, Entra ID) provides to the rest of the app. */
export interface AuthContextValue {
  mode: AuthMode;
  status: AuthStatus;
  /** Partitions the query cache so one identity's data is never shown to another. Changes on sign-in/out/persona switch. */
  identityKey: string;
  /** Headers attached to every API call; rejects when the person must sign in first. */
  getAuthHeaders: () => Promise<Record<string, string>>;
  /** Interactive sign-in (Entra). Absent for the development identity, which uses the persona picker. */
  signIn?: () => Promise<void>;
  signOut: () => Promise<void>;
  dev?: DevIdentityControls;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/** The active identity strategy. Must be used under `AuthProviderRoot`. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProviderRoot>');
  return value;
}

/** Thrown by `getAuthHeaders` when there is no identity yet. */
export class AuthRequiredError extends Error {
  constructor(message = 'Sign-in is required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}
