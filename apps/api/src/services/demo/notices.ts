import { AZURE_VALIDATION_NOTE } from '@caseguard/ai';
import type { ProviderStatus } from '@caseguard/schemas';

/** What the guide calls the data it shows (it never claims anything else). */
export const DEMO_DATASET_LABEL = 'Synthetic demonstration data';

/**
 * The honesty notices of the guide: what the data is, what produced the numbers and how far the
 * Azure integrations have been validated. Written for a presenter to read out.
 */
export function demoNotices(provider: Pick<ProviderStatus, 'simulated'>): string[] {
  return [
    'Every case, person and organisation in this demo is synthetic. No customer data is used.',
    provider.simulated
      ? 'The AI provider is the deterministic offline engine: results are simulated and reproducible, and token figures are estimates, not Azure OpenAI usage.'
      : AZURE_VALIDATION_NOTE,
    'Counterfactual paths, avoidable effort and improvement figures are simulated estimates, not measurements.',
    'Nothing is deployed to Azure by this demo. Azure OpenAI, Microsoft Entra ID, Blob Storage and AI Search are implemented and validated against mocks or locally generated test keys only.',
  ];
}
