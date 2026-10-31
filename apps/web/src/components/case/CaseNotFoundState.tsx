'use client';

import { EmptyState, PageHeader } from '@caseguard/ui';
import { FolderRegular } from '@fluentui/react-icons';
import { LinkButton } from '../common/LinkButton';

/**
 * Shown instead of a case view when the case does not exist (the API answers a case of another workspace in the same
 * way): a plain explanation and a way back. A view must not wait for a case that will not come, so this replaces the
 * page, including its loading states.
 */
export function CaseNotFoundState() {
  return (
    <>
      <PageHeader title="Case not found" description="This case does not exist or was deleted." />
      <EmptyState
        headingLevel={2}
        icon={<FolderRegular />}
        title="We could not find that case"
        description="It may have been deleted, or the address may be mistyped."
        action={
          <LinkButton href="/cases" appearance="primary">
            Browse cases
          </LinkButton>
        }
      />
    </>
  );
}
