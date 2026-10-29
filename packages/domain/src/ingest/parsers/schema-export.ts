import {
  SkillContentSchema,
  caseBundleJsonSchema,
  knowledgePackJsonSchema,
} from '@caseguard/schemas';
import { z } from 'zod';

export interface JsonSchemaDocument {
  id: 'case-bundle' | 'knowledge-pack' | 'skill';
  /** File name used in `synthetic-data/knowledge/` and `docs/schemas/`. */
  fileName: string;
  title: string;
  schema: Record<string, unknown>;
}

/** Draft 2020-12 JSON Schema for the portable SkillDNA content (what curators author and review). */
export function skillJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://caseguard.example/schemas/skill.schema.json',
    title: 'CaseGuard SkillDNA content',
    description:
      'Reusable investigation skill: trigger conditions, decision sequence, candidate actions, safety constraints and source cases. Skills are governed: they are proposed, validated, reviewed by a distinct approver and only then published.',
    ...z.toJSONSchema(SkillContentSchema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
    }),
  };
}

/**
 * The downloadable JSON Schemas (FR-ING-09): case bundle, knowledge pack and SkillDNA content.
 * Pure and deterministic, so the committed files can be checked against it.
 */
export function buildJsonSchemaDocuments(): JsonSchemaDocument[] {
  return [
    {
      id: 'case-bundle',
      fileName: 'case-bundle.schema.json',
      title: 'Case bundle',
      schema: caseBundleJsonSchema(),
    },
    {
      id: 'knowledge-pack',
      fileName: 'knowledge-pack.schema.json',
      title: 'Workload knowledge pack',
      schema: knowledgePackJsonSchema(),
    },
    {
      id: 'skill',
      fileName: 'skill.schema.json',
      title: 'SkillDNA content',
      schema: skillJsonSchema(),
    },
  ];
}
