import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CASE_ID, caseDetail } from '../../../test/case-fixtures';
import { session } from '../../../test/fixtures';
import { expectNoAxeViolations, fakeApi, renderApp } from '../../../test/harness';
import { navigateTo, router } from '../../../test/next-navigation';
import { ApiError } from '../../lib/api/errors';
import { CaseChrome } from './CaseChrome';

function mount(path: string, detail: () => unknown = () => caseDetail()) {
  navigateTo(path);
  return renderApp(
    <CaseChrome caseId={CASE_ID}>
      <h1>Page title</h1>
    </CaseChrome>,
    {
      api: fakeApi({
        'session.me': () => session('engineer', ['case:read']),
        'cases.get': detail as () => never,
      }),
    },
  );
}

describe('[UX-CASE-CHROME-01] the header and tabs every case page shares', () => {
  it('names the case and lists the five main tabs as links, marking the current one', async () => {
    mount(`/cases/${CASE_ID}/timeline`);
    const detail = caseDetail();
    expect(await screen.findByText(detail.reference)).toBeInTheDocument();
    expect(screen.getByText(detail.title)).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Case sections' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Review', 'Score', 'Evidence', 'What if', 'Timeline']);
    expect(within(tabs).getByRole('link', { name: 'Timeline' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(tabs).getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      `/cases/${CASE_ID}/review`,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Page title' })).toBeInTheDocument();
  });

  it('keeps the less used pages under More and lights it when one of them is open', async () => {
    const user = userEvent.setup();
    mount(`/cases/${CASE_ID}/hypotheses`);
    const more = await screen.findByRole('button', { name: 'More' });
    await user.click(more);
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Possible causes', 'Case details', 'Report']);
    expect(within(menu).getByRole('menuitem', { name: 'Possible causes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(menu).getByRole('menuitem', { name: 'Report' }));
    expect(router.push).toHaveBeenCalledWith(`/cases/${CASE_ID}/report`);
  });

  it('shows no tabs for a case that does not exist, leaving the page to say so', async () => {
    mount(`/cases/${CASE_ID}/review`, () => {
      throw new ApiError({ status: 404, code: 'not_found', title: 'Not found' });
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Page title' })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.queryByRole('navigation', { name: 'Case sections' })).toBeNull(),
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = mount(`/cases/${CASE_ID}/review`);
    await screen.findByText(caseDetail().reference);
    await expectNoAxeViolations(container);
  });
});
