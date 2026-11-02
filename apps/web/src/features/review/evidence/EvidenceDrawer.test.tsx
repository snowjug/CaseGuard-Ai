import type { EvidenceLink, ProvenanceItem } from '@caseguard/schemas';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CASE_ONE, PROVENANCE_ONE } from '../../../../test/review-fixtures';
import { expectNoAxeViolations, renderApp } from '../../../../test/harness';
import { navigateTo, router } from '../../../../test/next-navigation';
import { calledRoutes, provenanceFor, reviewApi } from '../../../../test/review-support';
import { ApiError } from '../../../lib/api/errors';
import { EvidenceChips } from './EvidenceChips';
import { EvidenceProvider } from './EvidenceProvider';
import { useLinkTitles } from './useProvenance';

configure({ asyncUtilTimeout: 5000 });

const CASE_ID = CASE_ONE.detail.id;
const SUBJECT = 'Write causes as hypotheses until evidence supports them';
/** claim, claim, event, event: the evidence of the first quality improvement, each with the label the engine gave it. */
const LINKS: EvidenceLink[] = CASE_ONE.quality.improvements[0]?.evidence ?? [];

function Harness({ links = LINKS }: { links?: readonly EvidenceLink[] }) {
  const titles = useLinkTitles(CASE_ID, links);
  return (
    <EvidenceProvider caseId={CASE_ID}>
      <main>
        <section aria-label="A recommendation">
          <h2>{SUBJECT}</h2>
          <EvidenceChips links={links} subject={SUBJECT} titles={titles} />
        </section>
      </main>
    </EvidenceProvider>
  );
}

const chip = (name: RegExp | string) => screen.findByRole('button', { name });
const drawer = () => screen.findByRole('dialog', { name: 'Evidence' });

describe('[REV-EVID-02] from a recommendation to the source passage in two interactions', () => {
  it('opens at the chip and shows the verified quotation with the match highlighted and the checked badge', async () => {
    const user = userEvent.setup();
    const api = reviewApi();
    renderApp(<Harness />, { api });
    await user.click(await chip(/^Statement: Root cause is the Conditional Access policy/));
    const panel = within(await drawer());

    expect(
      await panel.findByRole('heading', {
        level: 3,
        name: /^Root cause is the Conditional Access policy/,
      }),
    ).toBeVisible();
    expect(panel.getAllByText('Checked against the stored message')).toHaveLength(2);
    const mark = panel.getByText('Root cause is', { selector: 'mark' });
    expect(mark.closest('blockquote')).toHaveTextContent(
      /Findings: the sign-in logs show AADSTS50076.*Root cause is the Conditional Access policy 'Require MFA for Teams'/s,
    );
    expect(panel.getAllByText('Support engineer · 9 Mar 2026, 12:10 UTC')[0]).toBeVisible();
    expect(panel.getAllByRole('link', { name: 'Show in timeline' })[0]).toHaveAttribute(
      'href',
      `/cases/${CASE_ID}/timeline?sel=e07`,
    );
    // One request resolved every link of the recommendation.
    expect(calledRoutes(api).filter((route) => route === 'provenance.resolve')).toHaveLength(1);
    const [, input] = api.call.mock.calls.find((call) => call[0] === 'provenance.resolve') ?? [];
    expect((input as { query: { links: string } }).query.links).toBe(
      LINKS.map((link) => `${link.type}:${link.id}`).join(','),
    );
  });

  it('shows the item that was asked about first, then the others', async () => {
    const user = userEvent.setup();
    renderApp(<Harness />, { api: reviewApi() });
    await user.click(await chip(/^Message or event: Proposed change: exclude affected users/));
    const panel = within(await drawer());
    const headings = await panel.findAllByRole('heading', { level: 3 });
    expect(headings[0]).toHaveTextContent(
      'Proposed change: exclude affected users from the MFA policy',
    );
    expect(headings).toHaveLength(4);
  });

  it('takes the reader to the message in the timeline without losing the drawer on the way back', async () => {
    const user = userEvent.setup();
    renderApp(<Harness />, { api: reviewApi() });
    await user.click(await chip(/^Statement: Root cause is/));
    // The address names the item, so Back from the timeline reopens the drawer where it was.
    await waitFor(() =>
      expect(window.location.search).toContain('evidence=claim%3Aclm_3abfa6d712cd5f44c6eb2a93'),
    );
    const panel = within(await drawer());
    await user.click(
      (await panel.findAllByRole('link', { name: 'Show in timeline' }))[0] as HTMLElement,
    );
    expect(router.push).toHaveBeenCalledWith(`/cases/${CASE_ID}/timeline?sel=e07`);
  });

  it('reopens at the item named in the address, with just that item when nothing else is known', async () => {
    navigateTo(
      `/cases/${CASE_ID}/review?evidence=${encodeURIComponent('claim:clm_3abfa6d712cd5f44c6eb2a93')}`,
    );
    renderApp(<Harness />, { api: reviewApi() });
    const panel = within(await drawer());
    expect(await panel.findAllByRole('heading', { level: 3 })).toHaveLength(1);
    expect(panel.getByText('Checked against the stored message')).toBeVisible();
  });

  it('ignores an address that names something that is not a link', async () => {
    navigateTo(`/cases/${CASE_ID}/review?evidence=nonsense`);
    renderApp(<Harness />, { api: reviewApi() });
    await screen.findAllByRole('button', { name: /^Statement:/ });
    expect(screen.queryByRole('dialog', { name: 'Evidence' })).toBeNull();
  });
});

describe('[REV-EVID-03] honest about what could not be checked', () => {
  const as = (verification: 'mismatch' | 'not_checkable'): ProvenanceItem[] =>
    PROVENANCE_ONE.items.map((item) =>
      item.source ? { ...item, source: { ...item.source, verification, context: null } } : item,
    );

  it('says an excerpt could not be matched and does not show it as a quotation', async () => {
    const user = userEvent.setup();
    const api = reviewApi({
      handlers: {
        'provenance.resolve': (input) =>
          provenanceFor((input as { query: { links: string } }).query, {
            ...PROVENANCE_ONE,
            items: as('mismatch'),
          }),
      },
    });
    renderApp(<Harness />, { api });
    await user.click(await chip(/^Statement: Root cause is/));
    const panel = within(await drawer());
    expect(await panel.findAllByText('Could not be matched to the stored message')).toHaveLength(2);
    expect(panel.queryByText('Checked against the stored message')).toBeNull();
    expect(panel.queryByText('Root cause is', { selector: 'mark' })).toBeNull();
    expect(document.querySelector('blockquote')).toBeNull();
  });

  it('shows only the title of a derived item and says there is no quotation', async () => {
    const user = userEvent.setup();
    const api = reviewApi({
      handlers: {
        'provenance.resolve': (input) =>
          provenanceFor((input as { query: { links: string } }).query, {
            ...PROVENANCE_ONE,
            items: as('not_checkable'),
          }),
      },
    });
    renderApp(<Harness />, { api });
    await user.click(await chip(/^Statement: Root cause is/));
    const panel = within(await drawer());
    expect(await panel.findAllByText('Derived, no quotation')).toHaveLength(2);
    expect(document.querySelector('blockquote')).toBeNull();
  });

  it('reports a link that could not be found instead of dropping it', async () => {
    const user = userEvent.setup();
    const links: EvidenceLink[] = [
      ...LINKS.slice(0, 1),
      { type: 'claim', id: 'clm_gone', label: 'A statement that no longer exists' },
    ];
    renderApp(<Harness links={links} />, { api: reviewApi() });
    await user.click(await chip(/^Statement: Root cause is/));
    const panel = within(await drawer());
    expect(await panel.findByText('Not found')).toBeVisible();
    expect(panel.getByText(/A statement that no longer exists/)).toBeVisible();
    expect(panel.getByText(/not in the case any more/)).toBeVisible();
  });

  it('offers a retry when the evidence cannot be read, and then shows it', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const api = reviewApi({
      handlers: {
        'provenance.resolve': (input) => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({ status: 501, code: 'not_implemented', title: 'Not implemented' });
          return provenanceFor((input as { query: { links: string } }).query);
        },
      },
    });
    renderApp(<Harness />, { api });
    await user.click(await chip(/^Statement: Root cause is/));
    const panel = within(await drawer());
    await user.click(await panel.findByRole('button', { name: 'Retry' }));
    expect(await panel.findAllByText('Checked against the stored message')).toHaveLength(2);
  });
});

describe('[REV-EVID-04] keyboard use and accessibility', () => {
  it('closes with Escape and gives focus back to the chip that opened it', async () => {
    const user = userEvent.setup();
    renderApp(<Harness />, { api: reviewApi() });
    const opener = await chip(/^Statement: Root cause is/);
    opener.focus();
    await user.keyboard('{Enter}');
    await drawer();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Evidence' })).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(window.location.search).not.toContain('evidence');
  });

  it('closes with its close button', async () => {
    const user = userEvent.setup();
    renderApp(<Harness />, { api: reviewApi() });
    await user.click(await chip(/^Statement: Root cause is/));
    const panel = within(await drawer());
    await user.click(panel.getByRole('button', { name: 'Close the evidence' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Evidence' })).toBeNull());
  });

  it('has no accessibility violations with a quotation showing', async () => {
    const user = userEvent.setup();
    renderApp(<Harness />, { api: reviewApi() });
    await user.click(await chip(/^Statement: Root cause is/));
    await within(await drawer()).findAllByText('Checked against the stored message');
    await expectNoAxeViolations(document.body);
  });
});

describe('[REV-EVID-05] the chips', () => {
  it('shows a few chips and the rest behind "and N more", which opens at the first hidden one', async () => {
    const user = userEvent.setup();
    const six: EvidenceLink[] = [
      ...LINKS,
      { type: 'event', id: 'e09', label: 'Revoke sign-in sessions' },
      { type: 'event', id: 'e15', label: 'Review of HAR summary' },
    ];
    renderApp(<Harness links={six} />, { api: reviewApi() });
    const list = within(await screen.findByRole('list', { name: `Evidence for ${SUBJECT}` }));
    expect(list.getAllByRole('button')).toHaveLength(5);
    await user.click(
      list.getByRole('button', { name: `Show 2 more pieces of evidence for ${SUBJECT}` }),
    );
    const panel = within(await drawer());
    const headings = await panel.findAllByRole('heading', { level: 3 });
    // The two hidden links are unknown to the fixture, so they are reported; the known ones are listed.
    expect(headings.length).toBeGreaterThan(0);
    expect(await panel.findByText('Not found')).toBeVisible();
  });

  it('names a link the engine did not label by what the evidence is, once it has been resolved', async () => {
    const unlabeled: EvidenceLink[] = [{ type: 'event', id: 'e07' }];
    renderApp(<Harness links={unlabeled} />, { api: reviewApi() });
    expect(await chip('Message or event: Findings from sign-in logs')).toBeVisible();
  });

  it('falls back to the kind and a short id when the titles cannot be read', async () => {
    const unlabeled: EvidenceLink[] = [{ type: 'evidence', id: 'evd_0123456789abcdef' }];
    const api = reviewApi({
      handlers: {
        'provenance.resolve': () => {
          throw new ApiError({ status: 501, code: 'not_implemented', title: 'Not implemented' });
        },
      },
    });
    renderApp(<Harness links={unlabeled} />, { api });
    expect(await chip('Evidence: Evidence evd_01234567…')).toBeVisible();
  });

  it('renders nothing when a recommendation has no evidence (the caller says so in words)', () => {
    renderApp(<Harness links={[]} />, { api: reviewApi() });
    expect(screen.queryByRole('list', { name: /^Evidence for/ })).toBeNull();
  });
});
