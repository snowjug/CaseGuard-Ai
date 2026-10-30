'use client';

import type { CaseSummary, DemoState, HealthStatus } from '@caseguard/schemas';
import { useApiQuery } from './api/hooks';
import { useAuth } from './auth/context';
import { useSession } from './auth/session';

export type NavBadgeTone = 'neutral' | 'warning' | 'danger';

/** A small figure on a navigation item: what to show, and the sentence that explains it to assistive technology. */
export interface NavBadge {
  text: string;
  description: string;
  tone: NavBadgeTone;
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** Cases (how many) and Quality Review (open warnings), from the case list the header switcher already loads. */
export function caseBadges(
  cases: readonly CaseSummary[],
  hasMore: boolean,
): Record<string, NavBadge> {
  const badges: Record<string, NavBadge> = {};
  if (cases.length > 0) {
    badges.cases = {
      text: `${cases.length}${hasMore ? '+' : ''}`,
      description: `${cases.length}${hasMore ? ' or more' : ''} ${cases.length === 1 && !hasMore ? 'case' : 'cases'}`,
      tone: 'neutral',
    };
  }
  const withWarnings = cases.filter((item) => item.openWarningCount > 0);
  const open = withWarnings.reduce((sum, item) => sum + item.openWarningCount, 0);
  if (open > 0) {
    badges.quality = {
      text: String(open),
      description: `${plural(open, 'open warning')} across ${plural(withWarnings.length, 'case')}`,
      tone: 'warning',
    };
  }
  return badges;
}

/** Demo Guide: progress through the story, as the API derived it. */
export function demoBadge(state: Pick<DemoState, 'steps'>): NavBadge | null {
  const total = state.steps.length;
  if (total === 0) return null;
  const done = state.steps.filter((step) => step.completed).length;
  return {
    text: `${done}/${total}`,
    description: `${done} of ${total} demo steps complete`,
    tone: 'neutral',
  };
}

const HEALTH_TEXT: Partial<Record<HealthStatus, { text: string; tone: NavBadgeTone }>> = {
  degraded: { text: 'Degraded', tone: 'warning' },
  unhealthy: { text: 'Down', tone: 'danger' },
  unknown: { text: 'Unknown', tone: 'warning' },
};

/** System Health: quiet when everything is healthy, a labelled marker when anything is not. */
export function systemBadge(status: HealthStatus): NavBadge | null {
  const known = HEALTH_TEXT[status];
  if (!known) return null;
  return { ...known, description: `System status: ${status}` };
}

export interface NavBadgeState {
  badges: Readonly<Record<string, NavBadge>>;
  /** True once the case list loaded and is empty: case-scoped items then say there are no cases at all. */
  noCases: boolean;
}

/** How often the figures that can change by themselves are re-read, while the tab is visible. */
const POLL_MS = 60_000;

/**
 * Figures for the navigation, all from the API and all optional: while something loads, fails, or the role may not read
 * it, that item simply has no badge. A route is only requested when the role holds its permission (`case:read` for the
 * case list and the demo state, `telemetry:read` for system health), and none of them is a heavy or metered route. The
 * demo state and system health are re-read once a minute while the tab is visible and not at all while it is hidden.
 * The case list is the header switcher's own request (shared cache).
 */
export function useNavBadges(): NavBadgeState {
  const auth = useAuth();
  const { can } = useSession();
  const ready = auth.status === 'ready';
  const canReadCases = ready && can('case:read');
  const cases = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: canReadCases, staleTime: 30_000 },
  );
  const demo = useApiQuery('demo.state', undefined, {
    enabled: canReadCases,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });
  const health = useApiQuery('system.health', undefined, {
    enabled: ready && can('telemetry:read'),
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });
  const badges: Record<string, NavBadge> = cases.data
    ? caseBadges(cases.data.items, cases.data.nextCursor !== null)
    : {};
  const demoItem = demo.data ? demoBadge(demo.data) : null;
  if (demoItem) badges.demo = demoItem;
  const systemItem = health.data ? systemBadge(health.data.status) : null;
  if (systemItem) badges.system = systemItem;
  return { badges, noCases: cases.data !== undefined && cases.data.items.length === 0 };
}
