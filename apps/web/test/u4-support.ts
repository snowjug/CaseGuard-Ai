import { act, screen } from '@testing-library/react';
import { SessionSchema, type Permission } from '@caseguard/schemas';
import { expect, vi } from 'vitest';
import { ALL_PERMISSIONS, caseSummary, session } from './fixtures';
import { fakeApi, type FakeHandlers } from './harness';
import {
  USER_ROSTER,
  auditEvent,
  auditPage,
  auditVerification,
  governanceSettings,
  promptVersion,
  providerStatus,
  reviewDecision,
} from './u4-fixtures';

/** Shared setup for the Governance tests: identities and a fake API that answers every route the page uses. */

export const admin = () => session('administrator', ALL_PERMISSIONS);

export const asRole =
  (role: Parameters<typeof session>[0], permissions: readonly Permission[]) => () =>
    session(role, permissions);

/** The administrator's session as it would be under Entra ID (roles come from the token). */
export const entraAdmin = () => SessionSchema.parse({ ...admin(), authMode: 'entra' });

/** A toast's title is rendered twice (the toast and Fluent's polite live region), so match all copies. */
export async function expectToast(text: string): Promise<void> {
  const found = await screen.findAllByText(text);
  expect(found.length).toBeGreaterThan(0);
}

/**
 * An IntersectionObserver that, like a real one, reports its element as soon as it is observed (the end of a short
 * list is in view) and again whenever the test scrolls the end of the list back into view. Code that rebuilds the
 * observer after a request, or that does not stop asking after a failure, repeats a failing request. Undo with
 * `vi.unstubAllGlobals()`.
 */
export function stubNearEndObserver(): { scrollToEnd: () => void } {
  interface Report {
    report: () => void;
  }
  const live = new Set<Report>();
  vi.stubGlobal(
    'IntersectionObserver',
    class implements Report {
      private timer: ReturnType<typeof setTimeout> | undefined;
      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      report(): void {
        this.callback([{ isIntersecting: true }]);
      }
      observe(): void {
        live.add(this);
        this.timer = setTimeout(() => this.report(), 0);
      }
      unobserve(): void {
        live.delete(this);
        clearTimeout(this.timer);
      }
      disconnect(): void {
        live.delete(this);
        clearTimeout(this.timer);
      }
    },
  );
  return {
    scrollToEnd: () =>
      act(() => {
        for (const observer of live) observer.report();
      }),
  };
}

export function governanceApi(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': admin,
    'governance.get': () => governanceSettings(),
    'governance.prompts': () => ({ items: [promptVersion()] }),
    'governance.users': () => ({ items: [...USER_ROSTER] }),
    'governance.audit': () =>
      auditPage([
        auditEvent({ sequence: 2 }),
        auditEvent({ sequence: 1, action: 'case.ingested' }),
      ]),
    'governance.auditVerify': () => auditVerification(),
    'governance.reviews': () => ({ items: [reviewDecision()], nextCursor: null }),
    'system.provider': () => providerStatus(),
    'cases.list': () => ({ items: [caseSummary()], nextCursor: null }),
    ...overrides,
  });
}
