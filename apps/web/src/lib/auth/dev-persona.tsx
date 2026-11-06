'use client';

import { ROLE_LABELS, type Persona } from '@caseguard/schemas';
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  borderColors,
  cg,
  createPersistedStore,
  useHydrated,
  type PersistedStore,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CheckIcon, UserRoundCogIcon } from 'lucide-react';
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { describeError } from '../api/errors';
import { useApiQuery } from '../api/hooks';
import { useOverlayState } from '../use-overlay-state';
import { AuthContext, useAuth, type AuthContextValue } from './context';
import { PERSONA_COOKIE, PERSONA_STORAGE_KEY, parsePersonaId } from './persona-id';

export { PERSONA_COOKIE, PERSONA_STORAGE_KEY, parsePersonaId };

/** localStorage-backed selection. Exported as a factory so tests can inject their own storage. */
export function createPersonaStore(
  getStorage?: () => Storage | undefined,
): PersistedStore<string | null> {
  return createPersistedStore<string | null>({
    key: PERSONA_STORAGE_KEY,
    parse: parsePersonaId,
    serialize: (value) => value,
    ...(getStorage ? { getStorage } : {}),
  });
}

const defaultStore = createPersonaStore();

/** Persists the choice in a first-party `SameSite=Strict` cookie (development identity only), alongside localStorage. */
function writePersonaCookie(personaId: string | null): void {
  if (typeof document === 'undefined') return;
  document.cookie = personaId
    ? `${PERSONA_COOKIE}=${encodeURIComponent(personaId)}; Path=/; SameSite=Strict; Max-Age=604800`
    : `${PERSONA_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0`;
}

export interface DevPersonaAuthProviderProps {
  children: ReactNode;
  /**
   * The persona the server knows from the cookie. It is not the identity (the browser's own choice is); it only tells the
   * server render and the hydration render that someone was signed in, so pages show their skeleton instead of the
   * first-visit page for the moment before the browser takes over.
   */
  initialPersonaId?: string | null;
  /** Injected for tests. */
  store?: PersistedStore<string | null>;
  writeCookie?: (personaId: string | null) => void;
}

/**
 * Development identity: the person picks one of the seeded synthetic personas and every API call carries
 * `x-cg-persona`. The API only honours it in local/test environments; production uses Entra ID.
 *
 * The server and the hydration render cannot read localStorage, so they cannot know who is signed in. When the cookie says
 * someone was, the status is `loading` (every page shows its skeleton) instead of `unauthenticated` (the first-visit page)
 * until the browser's own choice takes over; nothing is requested for that identity before then, so the server's HTML and
 * the first client render stay identical.
 */
export function DevPersonaAuthProvider({
  children,
  initialPersonaId = null,
  store = defaultStore,
  writeCookie = writePersonaCookie,
}: DevPersonaAuthProviderProps) {
  const personaId = useSyncExternalStore(store.subscribe, store.get, () => null);
  const hydrated = useHydrated();
  const [pickerOpen, setPickerOpen] = useOverlayState();

  const selectPersona = useCallback(
    (next: string | null) => {
      store.set(next);
      writeCookie(next);
      setPickerOpen(false);
    },
    [store, writeCookie, setPickerOpen],
  );
  const getAuthHeaders = useCallback(
    async (): Promise<Record<string, string>> => (personaId ? { 'x-cg-persona': personaId } : {}),
    [personaId],
  );
  const openPicker = useCallback(() => setPickerOpen(true), [setPickerOpen]);
  const closePicker = useCallback(() => setPickerOpen(false), [setPickerOpen]);

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: 'dev',
      status: personaId
        ? 'ready'
        : !hydrated && initialPersonaId !== null
          ? 'loading'
          : 'unauthenticated',
      identityKey: personaId ? `dev:${personaId}` : 'dev:none',
      getAuthHeaders,
      signOut: async () => selectPersona(null),
      dev: { personaId, selectPersona, pickerOpen, openPicker, closePicker },
    }),
    [
      personaId,
      hydrated,
      initialPersonaId,
      getAuthHeaders,
      selectPersona,
      pickerOpen,
      openPicker,
      closePicker,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Badge that makes the development identity impossible to miss. */
export function DevIdentityBadge({ size = 'small' }: { size?: 'small' | 'medium' }) {
  return (
    <Badge
      tone="uncertain"
      dashed
      icon={<UserRoundCogIcon />}
      size={size === 'small' ? 'sm' : 'md'}
      title="Development identity: personas are synthetic and not real authentication"
    >
      Development identity
    </Badge>
  );
}

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    boxSizing: 'border-box',
    width: '100%',
    minHeight: '64px',
    padding: `${cg.space[3]} ${cg.space[4]}`,
    border: `1px solid ${cg.glassBorder}`,
    borderRadius: cg.radius.lg,
    backgroundColor: cg.surface,
    color: cg.text,
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'border-color, background-color',
    transitionDuration: cg.motion.fast,
    ':hover': { backgroundColor: cg.surfaceRaised, ...borderColors(cg.borderControl) },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  chosen: {
    backgroundColor: cg.tone.brand.tint,
    ...borderColors(cg.tone.brand.border),
    ':hover': { backgroundColor: cg.tone.brand.tint, ...borderColors(cg.tone.brand.border) },
  },
  avatar: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: cg.radius.pill,
    backgroundImage: cg.gradientAccent,
    color: cg.tone.brand.onSolid,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    '::before': { content: 'attr(data-initials)' },
  },
  text: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    flex: '1 1 auto',
  },
  name: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  meta: { color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  check: { flexShrink: 0, color: cg.tone.brand.fg, fontSize: tokens.fontSizeBase500 },
  content: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  note: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
});

const initialsOf = (name: string): string =>
  name
    .replace(/\s*\(.*\)\s*$/, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';

/** The seeded personas as selectable rows: name and role, a line about what they can do, and a check on the chosen one. */
export function PersonaList({
  personas,
  chosenId,
  onSelect,
  showTenant = true,
  className,
}: {
  personas: readonly Persona[];
  chosenId: string | null;
  onSelect: (personaId: string) => void;
  showTenant?: boolean;
  className?: string;
}) {
  const styles = useStyles();
  return (
    <ul className={mergeClasses(styles.list, className)} aria-label="Personas">
      {personas.map((persona) => {
        const chosen = persona.id === chosenId;
        return (
          <li key={persona.id}>
            <button
              type="button"
              className={mergeClasses(styles.option, chosen && styles.chosen)}
              aria-pressed={chosen}
              onClick={() => onSelect(persona.id)}
            >
              <span
                className={styles.avatar}
                aria-hidden="true"
                data-initials={initialsOf(persona.displayName)}
              />
              <span className={styles.text}>
                <span className={styles.name}>
                  {persona.displayName} · {ROLE_LABELS[persona.role]}
                </span>
                <span className={styles.meta}>{persona.description}</span>
                {showTenant ? (
                  <span className={styles.meta}>Tenant: {persona.tenantId}</span>
                ) : null}
              </span>
              {chosen ? (
                <span className={styles.check} aria-hidden="true">
                  <CheckIcon />
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Dialog that lists the seeded personas (`dev.personas`) and switches the identity. Render it once in the shell. */
export function PersonaPickerDialog() {
  const auth = useAuth();
  const dev = auth.dev;
  const styles = useStyles();
  const open = dev?.pickerOpen ?? false;
  const personas = useApiQuery('dev.personas', undefined, { enabled: open, staleTime: 5 * 60_000 });
  if (!dev) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? dev.openPicker() : dev.closePicker())}
      title="Choose a development identity"
    >
      <div className={styles.content}>
        <p className={styles.note}>
          <DevIdentityBadge /> These personas are demo identities. Switching changes what you are
          allowed to do; it is not real sign-in.
        </p>
        {personas.isPending ? (
          <LoadingSkeleton variant="list" count={3} label="Loading personas" />
        ) : null}
        {personas.isError ? (
          <ErrorState
            title="Personas could not be loaded"
            description={describeError(personas.error)}
            error={{
              status: personas.error.status,
              code: personas.error.code,
              correlationId: personas.error.correlationId,
            }}
            onRetry={() => void personas.refetch()}
            retrying={personas.isFetching}
            compact
          />
        ) : null}
        {personas.data && !personas.data.enabled ? (
          <EmptyState
            title="Development identity is disabled"
            description={personas.data.notice}
            compact
          />
        ) : null}
        {personas.data?.enabled ? (
          <>
            {personas.data.notice ? <p className={styles.note}>{personas.data.notice}</p> : null}
            <PersonaList
              personas={personas.data.items}
              chosenId={dev.personaId}
              onSelect={dev.selectPersona}
            />
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
