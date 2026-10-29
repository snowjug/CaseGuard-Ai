/**
 * How the Azure AI Search integration may be described anywhere it is mentioned (status screens,
 * notices, docs). It has only ever run against injected fakes.
 */
export const AZURE_SEARCH_VALIDATION_NOTE =
  'Azure AI Search is implemented (REST, managed-identity token, tenant filter) and validated against mocks only; ' +
  'it has not been exercised against a live search service. The index must be populated externally. ' +
  'Built-in lexical search is the default and the automatic fallback.';
