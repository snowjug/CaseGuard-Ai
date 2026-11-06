'use client';

import { Badge, Skeleton, StatusBadge, TabNav, cg } from '@caseguard/ui';
import {
  Menu,
  MenuItemLink,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ChevronDownIcon } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { type MouseEvent, type ReactNode } from 'react';
import { useCaseDetail } from '../../components/case/case-hooks';
import { ANALYSIS_STATE_BADGES, CASE_STATUS_LABELS } from '../../lib/labels';
import { CASE_TABS, type CaseTab } from '../../lib/nav';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[3], marginBottom: cg.space[6] },
  context: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    minHeight: '32px',
    '@media print': { display: 'none' },
  },
  reference: {
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    whiteSpace: 'nowrap',
  },
  title: {
    flex: '1 1 240px',
    minWidth: 0,
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: cg.text,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    '@media (max-width: 639px)': {
      whiteSpace: 'normal',
      WebkitLineClamp: 2,
      display: '-webkit-box',
      WebkitBoxOrient: 'vertical',
    },
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  tabs: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: cg.space[1],
    maxWidth: '100%',
    overflowX: 'auto',
    borderBottom: `1px solid ${cg.borderSubtle}`,
    '@media print': { display: 'none' },
  },
  tabList: { borderBottomWidth: 0, flexWrap: 'nowrap' },
  more: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    flexShrink: 0,
    minHeight: '44px',
    paddingInline: cg.space[3],
    border: 0,
    backgroundColor: 'transparent',
    color: cg.textSecondary,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    cursor: 'pointer',
    ':hover': { color: cg.text },
    ':focus-visible': {
      outline: `2px solid ${cg.focus}`,
      outlineOffset: '-2px',
      borderRadius: cg.radius.sm,
    },
  },
  moreActive: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  popover: {
    padding: cg.space[1],
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    boxShadow: cg.shadowHigh,
  },
});

const isPlainClick = (event: MouseEvent<HTMLElement>): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

const tabHref = (caseId: string, tab: CaseTab): string =>
  `/cases/${encodeURIComponent(caseId)}${tab.section}`;

/** A tab is current when the path is its page; the case's own page (`section` empty) only matches exactly. */
function isCurrent(pathname: string, caseId: string, tab: CaseTab): boolean {
  const base = tabHref(caseId, tab);
  return tab.section === ''
    ? pathname === base
    : pathname === base || pathname.startsWith(`${base}/`);
}

/** The case id as the router decoded it (a path segment can be percent-encoded). */
const decodedId = (caseId: string): string => {
  try {
    return decodeURIComponent(caseId);
  } catch {
    return caseId;
  }
};

/**
 * What every page of a case shares: which case this is (reference, title, status) and the tabs that move between its
 * pages. The tabs are real links; the less used pages sit under "More". Nothing prints (the report is a document).
 */
export function CaseChrome({ caseId, children }: { caseId: string; children: ReactNode }) {
  const styles = useStyles();
  const router = useRouter();
  const pathname = usePathname();
  const detail = useCaseDetail(caseId);
  const id = decodedId(caseId);
  const primary = CASE_TABS.filter((tab) => tab.primary);
  const more = CASE_TABS.filter((tab) => !tab.primary);
  const moreActive = more.some((tab) => isCurrent(pathname, id, tab));
  const data = detail.data;
  const analysis = data ? ANALYSIS_STATE_BADGES[data.analysisState] : null;

  // A case that does not exist shows its own page ("Case not found"); tabs to pages that cannot load would only mislead.
  // The page keeps its place in the tree either way, so it is not remounted (and refetched) when the header goes away.
  if (detail.isError && detail.error.isNotFound)
    return (
      <>
        {null}
        {children}
      </>
    );

  return (
    <>
      <div className={styles.root}>
        <div className={styles.context} aria-busy={detail.isPending}>
          {data ? (
            <>
              <span className={styles.reference}>{data.reference}</span>
              <p className={styles.title} title={data.title}>
                {data.title}
              </p>
              <span className={styles.badges}>
                {analysis ? <StatusBadge status={analysis.status} label={analysis.label} /> : null}
                <Badge tone="neutral" size="sm">
                  {CASE_STATUS_LABELS[data.status]}
                </Badge>
              </span>
            </>
          ) : (
            <>
              <Skeleton width={96} height={16} />
              <Skeleton width="min(420px, 60%)" height={16} />
            </>
          )}
        </div>
        <div className={styles.tabs}>
          <TabNav
            aria-label="Case sections"
            className={styles.tabList}
            items={primary.map((tab) => ({
              href: tabHref(id, tab),
              label: tab.label,
              active: isCurrent(pathname, id, tab),
            }))}
          />
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <button
                type="button"
                className={mergeClasses(styles.more, moreActive && styles.moreActive)}
              >
                More
                <ChevronDownIcon aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuPopover className={styles.popover}>
              <MenuList>
                {more.map((tab) => (
                  <MenuItemLink
                    key={tab.id}
                    href={tabHref(id, tab)}
                    aria-current={isCurrent(pathname, id, tab) ? 'page' : undefined}
                    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                      if (!isPlainClick(event)) return;
                      event.preventDefault();
                      router.push(tabHref(id, tab));
                    }}
                  >
                    {tab.label}
                  </MenuItemLink>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </div>
      {children}
    </>
  );
}
