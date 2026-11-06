import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { asPersona, listCases, waitForJob, type Api, type CaseSummary, type Job } from './api';
import { ROOT } from './env';
import { openPage, settle } from './ui';

export type SampleReference = 'CG-SYN-1001' | 'CG-SYN-1002';

export interface ThrowawayCase {
  readonly id: string;
  readonly reference: string;
}

/** The bundle of Case One as a plain object, under a reference nobody holds. */
export interface CaseBundle {
  case: { reference: string };
  events: { id: string; body: string }[];
}

export const uniqueReference = (): string =>
  `CG-E2E-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1_000)}`;

export function caseOneBundle(reference: string = uniqueReference()): CaseBundle {
  const bundle = JSON.parse(
    readFileSync(
      path.join(ROOT, 'synthetic-data', 'cases', 'case-one-teams-signin-dns.json'),
      'utf8',
    ),
  ) as CaseBundle;
  bundle.case.reference = reference;
  return bundle;
}

/**
 * A private, analysed copy of Case One under a unique reference, for the tests that change data (reviews, accepted
 * paths, generated strategies). The demo cases are never touched. Remove it with `deleteCase`.
 */
export async function createThrowawayCase(api: Api): Promise<ThrowawayCase> {
  const bundle = caseOneBundle();
  const created = await api.postOk<{ case: { id: string }; analysisJob: Job | null }>('/cases', {
    source: { type: 'bundle', bundle },
  });
  if (created.analysisJob) await waitForJob(api, created.analysisJob.id);
  return { id: created.case.id, reference: bundle.case.reference };
}

/**
 * Deletes a throw-away case (administrator only). A missing case is not an error; a case whose analysis is still running
 * answers 409 `job_active`, so the delete waits for the job and tries again instead of leaving the case behind.
 */
export async function deleteCase(caseId: string, timeoutMs = 120_000): Promise<void> {
  const admin = asPersona('admin');
  await expect
    .poll(
      async () => {
        const answer = await admin.delete(`/cases/${caseId}`);
        if (answer.ok || answer.status === 404) return 'gone';
        if (answer.problem?.reason === 'job_active') return 'busy';
        throw new Error(
          `DELETE /cases/${caseId} answered ${answer.status} ${answer.problem?.code ?? answer.text.slice(0, 200)}`,
        );
      },
      { message: `the case ${caseId} is deleted`, timeout: timeoutMs, intervals: [1_000] },
    )
    .toBe('gone');
}

/** The case of the workspace with this reference, polled until the API has it. */
export async function caseByReference(reference: string): Promise<CaseSummary> {
  let found: CaseSummary | undefined;
  await expect
    .poll(
      async () => {
        found = (await listCases(asPersona('engineer'))).find(
          (item) => item.reference === reference,
        );
        return found?.id ?? null;
      },
      { message: `the case ${reference} exists`, timeout: 60_000, intervals: [1_000] },
    )
    .not.toBeNull();
  return found!;
}

/** Waits until the API reports the case as analysed (the job of the wizard has finished). */
export async function waitUntilAnalysed(caseId: string, timeoutMs = 240_000): Promise<CaseSummary> {
  let latest: CaseSummary | undefined;
  await expect
    .poll(
      async () => {
        latest = (await listCases(asPersona('engineer'))).find((item) => item.id === caseId);
        return latest?.analysisState ?? 'missing';
      },
      { message: `the analysis of ${caseId} finishes`, timeout: timeoutMs, intervals: [2_000] },
    )
    .toBe('analyzed');
  return latest!;
}

/**
 * Loads one of the two built-in synthetic cases through the ingestion wizard, the way the demo does: choose the sample,
 * read the preview, confirm, create. Returns the id of the new case once its analysis has finished.
 */
export async function ingestBuiltInSample(page: Page, reference: SampleReference): Promise<string> {
  await openPage(page, '/cases/new?source=sample');
  await page.getByRole('radio', { name: new RegExp(`^${reference}:`) }).check();
  await page.getByRole('button', { name: 'Check case' }).click();
  await expect(page.getByRole('heading', { name: 'Check what will be created' })).toBeVisible();
  await expect(page.getByText(/Ready to create/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create and analyse' }).click();
  await expect(page.getByRole('heading', { name: 'Your case is ready' })).toBeVisible({
    timeout: 60_000,
  });
  const created = await caseByReference(reference);
  await waitUntilAnalysed(created.id);
  return created.id;
}

/** The dialog a consequential action opens (`ConfirmDialog` renders an alert dialog). */
export const confirmDialog = (page: Page): Locator => page.getByRole('alertdialog');

/**
 * Confirms a dialog: writes the reason when the dialog asks for one, then presses the confirm button (named like the
 * action). Waits for the dialog to close, so the next step starts on the updated page.
 */
export async function confirmWithReason(
  page: Page,
  confirmLabel: string,
  reason?: string,
): Promise<void> {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  if (reason !== undefined) await dialog.getByRole('textbox').fill(reason);
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await settle(page);
}

/** A toast (`Notifications` region) with this title. */
export const toast = (page: Page, title: string | RegExp): Locator =>
  page.getByRole('region', { name: 'Notifications' }).getByRole('listitem', { name: title });
