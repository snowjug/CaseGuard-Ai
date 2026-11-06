'use client';

import { UiLink, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ChevronRightIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useBreadcrumbLabels } from '../../lib/breadcrumbs';
import { buildBreadcrumbs } from '../../lib/nav';

const useStyles = makeStyles({
  nav: { marginBottom: cg.space[3] },
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cg.space[1],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
    fontSize: tokens.fontSizeBase200,
  },
  item: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    color: cg.textSecondary,
    minHeight: '24px',
  },
  link: {
    color: cg.textSecondary,
    textDecorationLine: 'none',
    fontWeight: tokens.fontWeightMedium,
    ':hover': { color: cg.text, textDecorationLine: 'underline' },
  },
  current: { color: cg.text, fontWeight: tokens.fontWeightMedium, overflowWrap: 'anywhere' },
  sep: { display: 'inline-flex', color: cg.textMuted },
});

/**
 * Breadcrumb trail, only where a page has depth (a case, a skill, an Advanced view, adding a case); top-level pages
 * show none. Pages can name dynamic segments with `useBreadcrumbLabel`.
 */
export function Breadcrumbs() {
  const styles = useStyles();
  const pathname = usePathname();
  const labels = useBreadcrumbLabels();
  const crumbs = buildBreadcrumbs(pathname, labels);
  if (crumbs.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb" className={styles.nav}>
      <ol className={styles.list}>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className={styles.item}>
              {crumb.href && !last ? (
                <UiLink href={crumb.href} className={styles.link}>
                  {crumb.label}
                </UiLink>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={styles.current}>
                  {crumb.label}
                </span>
              )}
              {!last ? (
                <span aria-hidden="true" className={styles.sep}>
                  <ChevronRightIcon />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
