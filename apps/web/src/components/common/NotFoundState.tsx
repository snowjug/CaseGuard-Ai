'use client';

import { Button, ButtonLink, EmptyState, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { FolderIcon, HouseIcon, PlayIcon, SearchIcon } from 'lucide-react';
import { useShellUi } from '../../lib/shell-ui';

const useStyles = makeStyles({
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2], justifyContent: 'center' },
});

/** 404 content: says what happened and offers four ways forward. Needs the shell (the search button opens the palette). */
export function NotFoundState() {
  const styles = useStyles();
  const { openSearch } = useShellUi();
  return (
    <EmptyState
      headingLevel={1}
      icon={<SearchIcon />}
      title="We couldn't find that page"
      description="The address may be mistyped, or the case or skill it pointed to no longer exists. Resetting the demo data removes the demo cases and skills, so links to them stop working."
      action={
        <div className={styles.actions}>
          <ButtonLink href="/" variant="primary" icon={<HouseIcon />}>
            Home
          </ButtonLink>
          <ButtonLink href="/cases" variant="secondary" icon={<FolderIcon />}>
            Browse cases
          </ButtonLink>
          <Button variant="secondary" icon={<SearchIcon />} onClick={openSearch}>
            Search
          </Button>
          <ButtonLink href="/demo" variant="ghost" icon={<PlayIcon />}>
            Guided demo
          </ButtonLink>
        </div>
      }
    />
  );
}
