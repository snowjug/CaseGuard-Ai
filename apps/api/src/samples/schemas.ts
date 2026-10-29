import { buildJsonSchemaDocuments } from '@caseguard/domain';

/** The downloadable JSON Schemas the API serves (FR-ING-09), keyed by what they describe. */
export interface SchemaDocuments {
  readonly caseBundle: Record<string, unknown>;
  readonly knowledgePack: Record<string, unknown>;
}

/** Builds the documents from the domain's schema export; the caller computes this once and keeps it. */
export function loadSchemaDocuments(): SchemaDocuments {
  const documents = buildJsonSchemaDocuments();
  const schemaOf = (id: 'case-bundle' | 'knowledge-pack'): Record<string, unknown> => {
    const found = documents.find((document) => document.id === id);
    if (found === undefined) throw new Error(`The schema export has no "${id}" document`);
    return found.schema;
  };
  return { caseBundle: schemaOf('case-bundle'), knowledgePack: schemaOf('knowledge-pack') };
}
