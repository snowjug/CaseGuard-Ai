import {
  ActivityIcon,
  ChartLineIcon,
  CirclePlayIcon,
  ClipboardCheckIcon,
  FlaskConicalIcon,
  FolderIcon,
  GaugeIcon,
  HistoryIcon,
  HouseIcon,
  LightbulbIcon,
  ListChecksIcon,
  PuzzleIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from 'lucide-react';

export interface NavContext {
  /** Case id found in the URL (`/cases/[caseId]/...`), or null. */
  pathCaseId: string | null;
  /** The active case: the URL's case, else the last case remembered in the `cg-case` cookie. */
  caseId: string | null;
}

export const ADD_CASE_HREF = '/cases/new';
/** Opens the add-a-case page on its sample tab, so a first-time user can see a review without any data of their own. */
export const SAMPLE_CASE_HREF = '/cases/new?source=sample';

/** The views that live under "Advanced": settings and audit, usage and cost, system status, the guided demo. */
export const ADVANCED_PATHS = [
  '/advanced',
  '/governance',
  '/efficiency',
  '/system',
  '/demo',
] as const;

const isAdvancedPath = (pathname: string): boolean =>
  ADVANCED_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

export interface PrimaryNavItem {
  id: 'home' | 'cases' | 'quality' | 'skills' | 'advanced';
  label: string;
  icon: LucideIcon;
  description: string;
  href: string;
  isActive: (pathname: string) => boolean;
}

/** The five items of the sidebar and of the bottom bar: nothing else is ever in the main navigation. */
export const PRIMARY_NAV: readonly PrimaryNavItem[] = [
  {
    id: 'home',
    label: 'Home',
    icon: HouseIcon,
    description: 'What needs attention, and where to start',
    href: '/',
    isActive: (p) => p === '/',
  },
  {
    id: 'cases',
    label: 'Cases',
    icon: FolderIcon,
    description: 'Add a case and open its review',
    href: '/cases',
    isActive: (p) => p === '/cases' || p.startsWith('/cases/'),
  },
  {
    id: 'quality',
    label: 'Quality',
    icon: ChartLineIcon,
    description: 'How quality trends across all cases',
    href: '/quality',
    isActive: (p) => p === '/quality',
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: PuzzleIcon,
    description: 'Reusable fixes that worked on earlier cases',
    href: '/skills',
    isActive: (p) => p === '/skills' || p.startsWith('/skills/'),
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: SlidersHorizontalIcon,
    description: 'Settings, audit and developer views',
    href: '/advanced',
    isActive: isAdvancedPath,
  },
];

/** The tabs of a case: real pages under `/cases/[caseId]`. The first five are shown; the rest sit under "More". */
export interface CaseTab {
  id:
    | 'review'
    | 'quality'
    | 'evidence'
    | 'counterfactual'
    | 'timeline'
    | 'hypotheses'
    | 'overview'
    | 'report';
  label: string;
  /** Path under the case (`''` is the case itself). */
  section: string;
  primary: boolean;
}

export const CASE_TABS: readonly CaseTab[] = [
  { id: 'review', label: 'Review', section: '/review', primary: true },
  { id: 'quality', label: 'Score', section: '/quality', primary: true },
  { id: 'evidence', label: 'Evidence', section: '/evidence', primary: true },
  { id: 'counterfactual', label: 'What if', section: '/counterfactual', primary: true },
  { id: 'timeline', label: 'Timeline', section: '/timeline', primary: true },
  { id: 'hypotheses', label: 'Possible causes', section: '/hypotheses', primary: false },
  { id: 'overview', label: 'Case details', section: '', primary: false },
  { id: 'report', label: 'Report', section: '/report', primary: false },
];

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** `case` destinations need an active case; without one they lead to the case list. */
  scope: 'global' | 'case';
  description: string;
  /** Second key of the `g <key>` sequence. */
  shortcutKey: string;
  href: (context: NavContext) => string;
  isActive: (pathname: string) => boolean;
}

const caseHref =
  (section: string) =>
  (context: NavContext): string =>
    context.caseId ? `/cases/${encodeURIComponent(context.caseId)}${section}` : '/cases';
const caseSection =
  (section: string) =>
  (pathname: string): boolean =>
    new RegExp(`^/cases/[^/]+${section}(?:/|$)`).test(pathname);

/**
 * Every destination, for the `g <key>` shortcuts and the command palette. The sidebar shows only `PRIMARY_NAV`; the
 * rest are reached through the case tabs and the Advanced page, and from here with the keyboard.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'command-center',
    label: 'Home',
    icon: HouseIcon,
    scope: 'global',
    description: 'What needs attention, and where to start',
    shortcutKey: 'd',
    href: () => '/',
    isActive: (p) => p === '/',
  },
  {
    id: 'cases',
    label: 'Cases',
    icon: FolderIcon,
    scope: 'global',
    description: 'Add a case and open its review',
    shortcutKey: 'c',
    href: () => '/cases',
    isActive: (p) => p === '/cases' || p === '/cases/new' || /^\/cases\/[^/]+$/.test(p),
  },
  {
    id: 'guided-review',
    label: 'Review',
    icon: ClipboardCheckIcon,
    scope: 'case',
    description: 'How the case went and what to fix first',
    shortcutKey: 'r',
    href: caseHref('/review'),
    // The report is the printable end of the review, so it keeps this destination lit.
    isActive: (p) => caseSection('/review')(p) || caseSection('/report')(p),
  },
  {
    id: 'timeline',
    label: 'Timeline',
    icon: HistoryIcon,
    scope: 'case',
    description: 'What happened, when, and what was known at the time',
    shortcutKey: 't',
    href: caseHref('/timeline'),
    isActive: caseSection('/timeline'),
  },
  {
    id: 'evidence',
    label: 'Evidence',
    icon: ListChecksIcon,
    scope: 'case',
    description: 'What each claim in the case is based on',
    shortcutKey: 'e',
    href: caseHref('/evidence'),
    isActive: caseSection('/evidence'),
  },
  {
    id: 'hypotheses',
    label: 'Possible causes',
    icon: LightbulbIcon,
    scope: 'case',
    description: 'Competing explanations and how likely each is',
    shortcutKey: 'h',
    href: caseHref('/hypotheses'),
    isActive: caseSection('/hypotheses'),
  },
  {
    id: 'counterfactual',
    label: 'What if',
    icon: FlaskConicalIcon,
    scope: 'case',
    description: 'What would have changed the outcome',
    shortcutKey: 'l',
    href: caseHref('/counterfactual'),
    isActive: caseSection('/counterfactual'),
  },
  {
    id: 'quality',
    label: 'Quality',
    icon: ChartLineIcon,
    scope: 'global',
    description: 'How quality trends across all cases, and the score of one case',
    shortcutKey: 'q',
    href: (context) =>
      context.pathCaseId ? `/cases/${encodeURIComponent(context.pathCaseId)}/quality` : '/quality',
    isActive: (p) => p === '/quality' || caseSection('/quality')(p),
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: PuzzleIcon,
    scope: 'global',
    description: 'Reusable fixes that worked on earlier cases',
    shortcutKey: 's',
    href: () => '/skills',
    isActive: (p) => p === '/skills' || p.startsWith('/skills/'),
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: SlidersHorizontalIcon,
    scope: 'global',
    description: 'Settings, audit and developer views',
    shortcutKey: 'a',
    href: () => '/advanced',
    isActive: (p) => p === '/advanced',
  },
  {
    id: 'efficiency',
    label: 'Usage and cost',
    icon: GaugeIcon,
    scope: 'global',
    description: 'Model usage and cost estimates',
    shortcutKey: 'm',
    href: () => '/efficiency',
    isActive: (p) => p === '/efficiency',
  },
  {
    id: 'governance',
    label: 'Settings and audit',
    icon: Settings2Icon,
    scope: 'global',
    description: 'Configuration, roles and the audit log',
    shortcutKey: 'g',
    href: () => '/governance',
    isActive: (p) => p === '/governance',
  },
  {
    id: 'system',
    label: 'System status',
    icon: ActivityIcon,
    scope: 'global',
    description: 'Dependencies, migrations and providers',
    shortcutKey: 'y',
    href: () => '/system',
    isActive: (p) => p === '/system',
  },
  {
    id: 'demo',
    label: 'Guided demo',
    icon: CirclePlayIcon,
    scope: 'global',
    description: 'The guided story with presenter notes',
    shortcutKey: 'p',
    href: () => '/demo',
    isActive: (p) => p === '/demo',
  },
];

/** `/cases/[caseId]/...` to the case id (never the `new` wizard route). */
export function caseIdFromPath(pathname: string): string | null {
  const match = /^\/cases\/([^/]+)/.exec(pathname);
  const id = match?.[1];
  if (!id || id === 'new') return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export function navContext(pathname: string, rememberedCaseId: string | null): NavContext {
  const pathCaseId = caseIdFromPath(pathname);
  return { pathCaseId, caseId: pathCaseId ?? rememberedCaseId };
}

export interface Crumb {
  label: string;
  /** Omitted for the current page. */
  href?: string;
}

const ADVANCED_LABELS: Record<string, string> = {
  efficiency: 'Usage and cost',
  governance: 'Settings and audit',
  system: 'System status',
  demo: 'Guided demo',
};

const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * Breadcrumb trail, only where a page has depth: a case (`Cases > CG-SYN-1001`), the add-a-case page, a skill and the
 * Advanced views. Top-level pages have none. Dynamic segments show their id unless a page registered a nicer label
 * (`useBreadcrumbLabel('case:<id>', 'CASE-0001')`). The tab of a case is not a crumb: the page title says where you are.
 */
export function buildBreadcrumbs(
  pathname: string,
  labels: Readonly<Record<string, string>> = {},
): Crumb[] {
  const segments = pathname.split('/').filter(Boolean).map(decode);
  const [first, second] = segments;
  if (first === 'cases' && second === 'new')
    return [{ label: 'Cases', href: '/cases' }, { label: 'Add a case' }];
  if (first === 'cases' && second) {
    return [{ label: 'Cases', href: '/cases' }, { label: labels[`case:${second}`] ?? second }];
  }
  if (first === 'skills' && second) {
    return [{ label: 'Skills', href: '/skills' }, { label: labels[`skill:${second}`] ?? second }];
  }
  if (first && second === undefined && first in ADVANCED_LABELS) {
    return [{ label: 'Advanced', href: '/advanced' }, { label: ADVANCED_LABELS[first] ?? first }];
  }
  if (first === 'design-lab') return [{ label: 'Design lab' }];
  return [];
}
