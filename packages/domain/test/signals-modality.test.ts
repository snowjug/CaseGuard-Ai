import { describe, expect, it } from 'vitest';
import type { CaseEvent, EventType, ParticipantRole } from '@caseguard/schemas';
import {
  MAX_SUPPRESSED_KEPT,
  createFullView,
  detectObservations,
  getCompiledPack,
  matchDetector,
  resolveActionKey,
  type SuppressedObservation,
} from '../src';

const pack = (() => {
  const compiled = getCompiledPack('teams-authentication');
  if (!compiled) throw new Error('the Teams pack is missing');
  return compiled;
})();

let counter = 0;
function eventOf(
  role: ParticipantRole,
  type: EventType,
  body: string,
  title: string | null = null,
): CaseEvent {
  counter += 1;
  const minute = String(counter % 60).padStart(2, '0');
  return {
    tenantId: 'tenant_test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'test',
    version: 1,
    id: `evt_${counter}`,
    caseId: 'case_1',
    sourceId: 'src_1',
    sequence: counter,
    timestamp: `2026-01-01T08:${minute}:00.000Z`,
    participantId: `p_${role}`,
    participantRole: role,
    participantAlias: role,
    type,
    channel: 'email',
    title,
    body,
    action: null,
    inResponseTo: null,
    correlationIds: [],
    structured: null,
    ai: null,
    sourcePointer: `/events/${counter}`,
    redaction: { redacted: false, categories: [] },
    immutable: true,
  };
}

function read(...events: CaseEvent[]) {
  const suppressed: SuppressedObservation[] = [];
  const view = createFullView(events, null);
  const observations = detectObservations(view, pack, 'case_1', { suppressed });
  const signals = (event: CaseEvent) =>
    observations.filter((o) => o.eventId === event.id).map((o) => o.signalId);
  return { observations, suppressed, signals };
}

describe('a signal needs a sentence that states it', () => {
  it('reads a stated fact', () => {
    const event = eventOf(
      'customer_end_user',
      'customer_email',
      'It happens intermittently for us.',
    );
    expect(read(event).signals(event)).toContain('sig.intermittent-failures');
  });

  it('does not read a denial of the fact', () => {
    const event = eventOf(
      'customer_end_user',
      'customer_email',
      'To be clear, this is not intermittent: it fails every single time I try.',
    );
    const { signals, suppressed } = read(event);
    expect(signals(event)).not.toContain('sig.intermittent-failures');
    expect(suppressed.find((s) => s.signalId === 'sig.intermittent-failures')).toMatchObject({
      modality: 'negated',
      cue: expect.stringMatching(/not/i),
    });
  });

  it('does not read a guess, a plan or a condition as a finding', () => {
    for (const body of [
      'I suspect it is intermittent but I have not checked.',
      'Next week I will check whether it is intermittent.',
      'If it turns out to be intermittent we will tell you.',
    ]) {
      const event = eventOf('customer_end_user', 'customer_email', body);
      expect(read(event).signals(event), body).not.toContain('sig.intermittent-failures');
    }
  });

  it('keeps a stated fact that follows a denial in the same message', () => {
    const event = eventOf(
      'customer_end_user',
      'customer_email',
      'It is not intermittent in Gdansk, but in Warsaw it fails intermittently.',
    );
    const { observations } = read(event);
    const hit = observations.find((o) => o.signalId === 'sig.intermittent-failures');
    expect(hit?.excerpt).toContain('Warsaw');
  });

  it('does not count what an e-mail only quotes from an earlier message', () => {
    const quoted = [
      'Thanks, we are looking at it.',
      '',
      'On Tue, 2 Jun 2026 at 09:10, Support Engineer <support@example.test> wrote:',
      '> Does the failure come and go? Is it intermittent?',
    ].join('\n');
    const event = eventOf('customer_end_user', 'customer_email', quoted);
    expect(read(event).signals(event)).not.toContain('sig.intermittent-failures');
    const unquoted = eventOf(
      'customer_end_user',
      'customer_email',
      'Thanks, we are looking at it. Is it intermittent? It is intermittent.',
    );
    expect(read(unquoted).signals(unquoted)).toContain('sig.intermittent-failures');
  });

  it('keeps an excerpt that points into the stored text, quoted history or not', () => {
    const body = ['Sign-ins fail intermittently.', '> earlier words about nothing'].join('\n');
    const event = eventOf('customer_end_user', 'customer_email', body);
    const hit = read(event).observations.find((o) => o.signalId === 'sig.intermittent-failures');
    expect(hit).toBeDefined();
    expect(body.slice(hit?.start ?? 0, hit?.end ?? 0)).toMatch(/intermittent/i);
  });
});

describe('a denial of one side of a declared pair is the other side', () => {
  const health = (body: string) => eventOf('support_engineer', 'diagnostic_result', body);

  it('reads "service health lists nothing active" as no active incident', () => {
    const event = health('Service health lists nothing active for sign-in or Teams.');
    const { observations, signals } = read(event);
    expect(signals(event)).toEqual(['sig.service-health-clear']);
    expect(observations[0]).toMatchObject({
      negationOf: 'sig.service-health-incident',
      modality: 'asserted',
    });
  });

  it('still reads an active incident as an incident', () => {
    const event = health('Service health shows an active incident for sign-in.');
    expect(read(event).signals(event)).toEqual(['sig.service-health-incident']);
  });

  it('does not invent the other side when the pair says a denial is not its opposite', () => {
    const event = eventOf('customer_end_user', 'customer_email', 'This is not just one user.');
    const { observations, suppressed } = read(event);
    expect(observations).toEqual([]);
    expect(suppressed.map((s) => s.signalId)).toEqual(['sig.single-user-scope']);
  });

  it('keeps a bounded list of what it set aside and still counts all of it', () => {
    const events = Array.from({ length: MAX_SUPPRESSED_KEPT + 40 }, () =>
      eventOf('customer_end_user', 'customer_email', 'This is not just one user.'),
    );
    const notes = { suppressed: [] as SuppressedObservation[], total: 0 };
    detectObservations(createFullView(events, null), pack, 'case_1', notes);
    expect(notes.suppressed).toHaveLength(MAX_SUPPRESSED_KEPT);
    expect(notes.total).toBe(events.length);
    // The kept notes are the first ones in the record's order, not a sample.
    expect(notes.suppressed.map((s) => s.eventIndex)).toEqual(
      Array.from({ length: MAX_SUPPRESSED_KEPT }, (_, index) => index),
    );
  });
});

describe('an engineer action is a step that was done, or one the customer was asked to take', () => {
  const engineer = (body: string, type: EventType = 'engineer_email') =>
    eventOf('support_engineer', type, body);

  it('counts a request for a step the customer takes', () => {
    expect(
      resolveActionKey(engineer('Please clear the Teams cache and sign in again.'), pack),
    ).toBe('act.clear-teams-cache');
  });

  it('does not count a step the engineer says not to take, or one that is only planned or conditional', () => {
    for (const body of [
      'Do not clear the Teams cache yet.',
      'There is no need to clear the cache.',
      'If the problem persists we could clear the Teams cache later.',
    ]) {
      expect(resolveActionKey(engineer(body), pack), body).toBeNull();
    }
  });

  it('counts a diagnostic step stated as done and not one that is denied, planned or only reported', () => {
    expect(
      resolveActionKey(
        engineer('Checked the sign-in logs for the three users.', 'engineer_action'),
        pack,
      ),
    ).toBe('act.signin-log-correlation');
    for (const body of [
      'No sign-in log review was performed.',
      'I will check the sign-in logs tomorrow.',
      'The customer said the sign-in logs were checked.',
      'We did not look at the sign-in logs.',
    ]) {
      expect(resolveActionKey(engineer(body, 'engineer_action'), pack), body).toBeNull();
    }
  });
});

describe('a question and the title of a reply are not statements', () => {
  const engineerNote = (body: string, title: string | null = null) =>
    eventOf('support_engineer', 'diagnostic_result', body, title);
  it('reads a denial as a denial, but not when it is asked about or the writer is only checking it', () => {
    const stated = engineerNote(
      'Checked: service health lists nothing active for sign-in or Teams.',
    );
    expect(read(stated).signals(stated)).toEqual(['sig.service-health-clear']);
    for (const body of [
      'Please check whether service health lists nothing active for sign-in or Teams.',
      'Does service health list nothing active for sign-in or Teams?',
      'And does service health list nothing active for Teams, or is there an incident?',
    ]) {
      const event = engineerNote(body);
      expect(read(event).signals(event), body).toEqual([]);
    }
  });

  it('keeps a statement that is followed by a question', () => {
    const event = eventOf(
      'customer_end_user',
      'customer_email',
      'Around 120 users cannot sign in to Teams, does anyone know why?',
    );
    expect(read(event).signals(event)).toContain('sig.multiple-users-affected');
  });

  it('does not read the subject of a thread again at each reply', () => {
    const subject = 'Teams says the name could not be resolved in Gdansk';
    const first = eventOf('customer_end_user', 'customer_email', 'Please help.', subject);
    expect(read(first).signals(first)).toContain('sig.error-name-not-resolved');
    const reply = eventOf(
      'support_engineer',
      'engineer_email',
      'Thanks, I am looking at it now.',
      `Re: ${subject}`,
    );
    expect(read(reply).signals(reply)).toEqual([]);
    for (const marker of ['RE:', 'Fwd:', 'AW:', 'Re[2]:']) {
      const other = eventOf(
        'support_engineer',
        'engineer_email',
        'Thanks, I am looking at it now.',
        `${marker} ${subject}`,
      );
      expect(read(other).signals(other), marker).toEqual([]);
    }
  });

  it('still reads what a reply says in its own body', () => {
    const reply = eventOf(
      'customer_end_user',
      'customer_email',
      'The Teams window says the name of the server could not be resolved.',
      'Re: Cannot sign in to Teams',
    );
    expect(read(reply).signals(reply)).toContain('sig.error-name-not-resolved');
  });
});

describe('the older entry point still answers as it did', () => {
  it('returns a match for a stated fact, with its modality', () => {
    const event = eventOf('customer_end_user', 'customer_email', 'Users fail intermittently.');
    const detector = pack.signalDetectors.get('sig.intermittent-failures')?.[0];
    expect(detector).toBeDefined();
    const match = detector ? matchDetector(detector, event) : null;
    expect(match).toMatchObject({ method: 'pattern', modality: 'asserted', cue: null });
  });
});
