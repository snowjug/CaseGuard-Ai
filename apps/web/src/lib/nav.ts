import {
  BeakerRegular,
  ClipboardTaskListLtrRegular,
  DocumentBulletListRegular,
  FolderRegular,
  GaugeRegular,
  HistoryRegular,
  HomeRegular,
  LightbulbRegular,
  MoleculeRegular,
  OrganizationRegular,
  PlayCircleRegular,
  PulseRegular,
  ShieldCheckmarkRegular,
  type FluentIcon,
} from '@fluentui/react-icons';

/** The 13 destinations: the 12 of UI_SPEC section 2 and the guided review, which sits first among the case pages. */
export interface NavContext {
  /** Case id found in the URL (`/cases/[caseId]/...`), or null. */
  pathCaseId: string | null;
  /** The active case: the URL's case, else the last case remembered in the `cg-case` cookie. */
  caseId: string | null;
}

export interface NavItem {
  id: string;
  label: string;
  icon: FluentIcon;
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
    context.caseId ? `/cases/${encodeURIComponent(context.caseId)}/${section}` : '/cases';
const caseSection =
  (section: string) =>
  (pathname: string): boolean =>
    new RegExp(`^/cases/[^/]+/${section}(?:/|$)`).test(pathname);

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'command-center',
    label: 'Command Center',
    icon: HomeRegular,
    scope: 'global',
    description: 'Quality at a glance for the active case',
    shortcutKey: 'd',
    href: () => '/',
    isActive: (p) => p === '/',
  },
  {
    id: 'cases',
    label: 'Cases',
    icon: FolderRegular,
    scope: 'global',
    description: 'Ingest and browse support cases',
    shortcutKey: 'c',
    href: () => '/cases',
    isActive: (p) => p === '/cases' || p === '/cases/new' || /^\/cases\/[^/]+$/.test(p),
  },
  {
    id: 'guided-review',
    label: 'Guided Review',
    icon: ClipboardTaskListLtrRegular,
    scope: 'case',
    description: 'Verdict, chronology, what went wrong and what to do next',
    shortcutKey: 'r',
    href: caseHref('review'),
    // The report is the printable end of the guided review, so it keeps this destination lit.
    isActive: (p) => caseSection('review')(p) || caseSection('report')(p),
  },
  {
    id: 'timeline',
    label: 'Case Timeline',
    icon: HistoryRegular,
    scope: 'case',
    description: 'Events, delays and what was known when',
    shortcutKey: 't',
    href: caseHref('timeline'),
    isActive: caseSection('timeline'),
  },
  {
    id: 'evidence',
    label: 'Evidence Ledger',
    icon: DocumentBulletListRegular,
    scope: 'case',
    description: 'Claims classified into eight evidence categories',
    shortcutKey: 'e',
    href: caseHref('evidence'),
    isActive: caseSection('evidence'),
  },
  {
    id: 'hypotheses',
    label: 'Hypothesis Arena',
    icon: LightbulbRegular,
    scope: 'case',
    description: 'Competing hypotheses and their confidence',
    shortcutKey: 'h',
    href: caseHref('hypotheses'),
    isActive: caseSection('hypotheses'),
  },
  {
    id: 'counterfactual',
    label: 'Counterfactual Lab',
    icon: BeakerRegular,
    scope: 'case',
    description: 'Simulated alternative paths from a decision fork',
    shortcutKey: 'l',
    href: caseHref('counterfactual'),
    isActive: caseSection('counterfactual'),
  },
  {
    id: 'quality',
    label: 'Quality Review',
    icon: ShieldCheckmarkRegular,
    scope: 'global',
    description: 'Portfolio analytics and per-case review',
    shortcutKey: 'q',
    href: (context) =>
      context.pathCaseId ? `/cases/${encodeURIComponent(context.pathCaseId)}/quality` : '/quality',
    isActive: (p) => p === '/quality' || caseSection('quality')(p),
  },
  {
    id: 'skills',
    label: 'SkillDNA Library',
    icon: MoleculeRegular,
    scope: 'global',
    description: 'Governed, reusable investigation skills',
    shortcutKey: 's',
    href: () => '/skills',
    isActive: (p) => p === '/skills' || p.startsWith('/skills/'),
  },
  {
    id: 'efficiency',
    label: 'Efficiency Monitor',
    icon: GaugeRegular,
    scope: 'global',
    description: 'Token and compute efficiency (estimated)',
    shortcutKey: 'm',
    href: () => '/efficiency',
    isActive: (p) => p === '/efficiency',
  },
  {
    id: 'governance',
    label: 'Governance',
    icon: OrganizationRegular,
    scope: 'global',
    description: 'Configuration, roles and the audit log',
    shortcutKey: 'g',
    href: () => '/governance',
    isActive: (p) => p === '/governance',
  },
  {
    id: 'system',
    label: 'System Health',
    icon: PulseRegular,
    scope: 'global',
    description: 'Dependencies, migrations and providers',
    shortcutKey: 'y',
    href: () => '/system',
    isActive: (p) => p === '/system',
  },
  {
    id: 'demo',
    label: 'Demo Guide',
    icon: PlayCircleRegular,
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

const SEGMENT_LABELS: Record<string, string> = {
  cases: 'Cases',
  new: 'New case',
  review: 'Guided Review',
  report: 'Report',
  timeline: 'Case Timeline',
  evidence: 'Evidence Ledger',
  hypotheses: 'Hypothesis Arena',
  counterfactual: 'Counterfactual Lab',
  quality: 'Quality Review',
  skills: 'SkillDNA Library',
  efficiency: 'Efficiency Monitor',
  governance: 'Governance',
  system: 'System Health',
  demo: 'Demo Guide',
  'design-lab': 'Design lab',
};

const titleCase = (segment: string): string =>
  segment.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/**
 * Breadcrumb trail from the URL. Dynamic segments show their id unless a page registered a nicer label
 * (`useBreadcrumbLabel('case:<id>', 'CASE-0001')`).
 */
export function buildBreadcrumbs(
  pathname: string,
  labels: Readonly<Record<string, string>> = {},
): Crumb[] {
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  if (segments.length === 0) return [{ label: 'Command Center' }];
  const crumbs: Crumb[] = [{ label: 'Command Center', href: '/' }];
  let href = '';
  segments.forEach((segment, index) => {
    href += `/${encodeURIComponent(segment)}`;
    const parent = segments[index - 1];
    let label = SEGMENT_LABELS[segment];
    if (parent === 'cases' && segment !== 'new') label = labels[`case:${segment}`] ?? segment;
    else if (parent === 'skills') label = labels[`skill:${segment}`] ?? segment;
    crumbs.push({
      label: label ?? titleCase(segment),
      ...(index < segments.length - 1 ? { href } : {}),
    });
  });
  return crumbs;
}
