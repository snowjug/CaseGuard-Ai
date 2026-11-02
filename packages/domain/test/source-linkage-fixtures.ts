import { CaseBundleSchema, type CaseBundle } from '@caseguard/schemas';

/** A small case written to put the awkward places in the text in front of the engine. */
export const AWKWARD: CaseBundle = CaseBundleSchema.parse({
  schemaVersion: 'caseguard.case-bundle/1',
  synthetic: true,
  syntheticNotice: 'SYNTHETIC DEMONSTRATION DATA authored for the source linkage tests.',
  case: {
    reference: 'CG-SYN-9100',
    title: 'Source linkage checks',
    product: 'Microsoft Teams',
    workload: 'teams-authentication',
    severity: 'C',
    status: 'resolved',
    openedAt: '2026-05-04T08:00:00Z',
    customerAlias: 'Adatum Synthetic',
    tags: ['synthetic'],
  },
  participants: [
    { id: 'p-user', role: 'customer_end_user', alias: 'End User 1' },
    { id: 'p-eng', role: 'support_engineer', alias: 'Support Engineer 3' },
  ],
  events: [
    {
      id: 'a01',
      timestamp: '2026-05-04T08:00:00Z',
      participantId: 'p-user',
      type: 'customer_email',
      channel: 'email',
      // The line break between the title and the body falls inside the text the pack looks for.
      title: 'Teams will not sign in, dsregcmd shows AzureAdPrt',
      body: ': YES on the laptop, but Teams still fails to sign in.\n\nSince about 08:50 UTC roughly 140 users are affected.',
    },
    {
      id: 'a02',
      timestamp: '2026-05-04T08:30:00Z',
      participantId: 'p-eng',
      type: 'engineer_email',
      channel: 'email',
      title: 'Re: Teams will not sign in',
      inResponseTo: 'a01',
      // Statements that start after spaces and tabs: the offset must point at the words, not at the margin.
      body: 'Hi,\n\n    The root cause is the DNS resolver policy.\n\t  Probably a stale cache as well.\n',
    },
  ],
});
