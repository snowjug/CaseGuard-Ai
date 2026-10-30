'use client';

import { EmptyState, cg } from '@caseguard/ui';
import { Button, makeStyles } from '@fluentui/react-components';
import { FolderRegular, HomeRegular, SearchRegular } from '@fluentui/react-icons';
import { useShellUi } from '../../lib/shell-ui';
import { LinkButton } from './LinkButton';

const useStyles = makeStyles({
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2], justifyContent: 'center' },
});

/** 404 content: says what happened and offers three ways forward. Needs the shell (it uses the search focus). */
export function NotFoundState() {
  const styles = useStyles();
  const { focusSearch } = useShellUi();
  return (
    <EmptyState
      headingLevel={1}
      icon={<SearchRegular />}
      title="We could not find that page"
      description="The address may be mistyped, or the case or skill it pointed to no longer exists."
      action={
        <div className={styles.actions}>
          <LinkButton href="/" appearance="primary" icon={<HomeRegular />}>
            Command Center
          </LinkButton>
          <LinkButton href="/cases" appearance="outline" icon={<FolderRegular />}>
            Browse cases
          </LinkButton>
          <Button appearance="outline" icon={<SearchRegular />} onClick={focusSearch}>
            Search
          </Button>
        </div>
      }
    />
  );
}
