import { z } from 'zod';
import { CaseBundleSchema } from './bundle';
import { KnowledgePackSchema } from './knowledge';

/** Draft 2020-12 JSON Schema for authoring case bundles (defaults are optional for authors). */
export function caseBundleJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://caseguard.example/schemas/case-bundle.schema.json',
    title: 'CaseGuard case bundle',
    description:
      'Structured support-case export accepted by CaseGuard ingestion. Demo bundles must set "synthetic": true.',
    ...z.toJSONSchema(CaseBundleSchema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
    }),
  };
}

export function knowledgePackJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://caseguard.example/schemas/knowledge-pack.schema.json',
    title: 'CaseGuard workload knowledge pack',
    description:
      'Authored domain model used by the deterministic provider and as grounding for model prompts.',
    ...z.toJSONSchema(KnowledgePackSchema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
    }),
  };
}
