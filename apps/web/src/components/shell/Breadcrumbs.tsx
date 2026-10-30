'use client';

import { UiLink, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ChevronRightRegular } from '@fluentui/react-icons';
import { usePathname } from 'next/navigation';
import { Fragment } from 'react';
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
    listStyle: 'none',
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
    color: cg.textLink,
    textDecorationLine: 'none',
    fontWeight: tokens.fontWeightSemibold,
    ':hover': { textDecorationLine: 'underline' },
  },
  current: { color: cg.text, fontWeight: tokens.fontWeightSemibold, overflowWrap: 'anywhere' },
  sep: { display: 'inline-flex', color: cg.textMuted },
});

/** Breadcrumb trail derived from the URL; pages can name dynamic segments with `useBreadcrumbLabel`. */
export function Breadcrumbs() {
  const styles = useStyles();
  const pathname = usePathname();
  const labels = useBreadcrumbLabels();
  const crumbs = buildBreadcrumbs(pathname, labels);
  return (
    <nav aria-label="Breadcrumb" className={styles.nav}>
      <ol className={styles.list}>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.label}-${index}`}>
              <li className={styles.item}>
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
                    <ChevronRightRegular />
                  </span>
                ) : null}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
