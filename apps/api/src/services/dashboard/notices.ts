import { MODEL_ESTIMATE_NOTICE } from '@caseguard/schemas';

export interface NoticeInputs {
  readonly hasCases: boolean;
  /** A case is shown (the one asked for, or the default). */
  readonly hasActiveCase: boolean;
  /** The shown case has stored estimates. */
  readonly activeAnalysed: boolean;
  /** A case was asked for but is not there, so the default is shown instead. */
  readonly requestedMissing: boolean;
  /** Reference of the case the trends compare with, when trends are shown. */
  readonly trendBase: string | null;
  readonly analysedCases: number;
  readonly providerSimulated: boolean;
}

/** Honest context for the page: what is missing, what is an estimate, and how thin the comparison is. */
export function commandCenterNotices(input: NoticeInputs): string[] {
  const notices: string[] = [];
  if (!input.hasCases) {
    notices.push(
      'There are no cases yet. Load the synthetic sample from Cases to see real analysis here; nothing on this page is placeholder data.',
    );
  }
  if (input.requestedMissing && input.hasActiveCase) {
    notices.push('The requested case was not found, so the most recent analysed case is shown.');
  }
  if (input.hasActiveCase && !input.activeAnalysed) {
    notices.push(
      'This case has not been analysed yet, so its metrics, hypotheses and warnings are not available.',
    );
  }
  if (input.activeAnalysed) notices.push(MODEL_ESTIMATE_NOTICE);
  if (input.trendBase !== null) {
    notices.push(
      `Trend arrows compare this case with the previous analysed case, ${input.trendBase}. With only ${input.analysedCases} analysed case(s) they are illustrative, not a trend over time.`,
    );
  }
  if (input.providerSimulated) {
    notices.push(
      'AI-assisted values come from the deterministic offline provider (simulated); token counts are estimates.',
    );
  }
  return notices;
}
