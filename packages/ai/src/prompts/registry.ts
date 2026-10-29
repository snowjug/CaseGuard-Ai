import { PromptVersionSchema, type AgentName, type PromptVersion } from '@caseguard/schemas';
import { OUTPUT_SCHEMAS } from '../agents/outputs';
import { toStrictJsonSchema, type JsonSchemaObject } from '../agents/json-schema';
import { sha256Hex } from '../util/hash';
import { wordShingles } from '../util/text';
import { PROMPT_TEMPLATES, SECURITY_PREAMBLE, type PromptTemplate } from './templates';

export interface RegisteredPrompt extends Readonly<PromptTemplate> {
  /** Identifier recorded on every execution, e.g. `prompt_timeline_analyzer_1.0.0`. */
  id: string;
  /** Canonical text that is hashed: preamble + system + task + output-schema fingerprint. */
  template: string;
  /** SHA-256 of `template`; recorded so every result is reproducible. */
  templateHash: string;
  schemaHash: string;
  /** The system message sent to the model: shared security preamble plus the agent role. */
  systemMessage: string;
  /** Strict JSON Schema sent to the model as the structured-output contract. */
  jsonSchema: Readonly<JsonSchemaObject>;
  /** Word 6-grams of the instructions; an output repeating them is leaking the prompt. */
  templateShingles: ReadonlySet<string>;
}

export interface PromptRecordMeta {
  tenantId: string;
  now: string;
  createdBy: string;
}

export interface PromptRegistry {
  /** Exact version when given, otherwise the highest active version of the agent's prompt. */
  get(agent: AgentName, version?: string): RegisteredPrompt;
  list(): readonly RegisteredPrompt[];
  /** Returns a new registry that also contains `template`; published versions are immutable. */
  with(template: PromptTemplate): PromptRegistry;
  /** Governance view of the registry (matches the `governance.prompts` route contract). */
  toRecords(meta: PromptRecordMeta): PromptVersion[];
}

const MAX_TEMPLATE_CHARS = 30_000;

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function register(template: PromptTemplate): RegisteredPrompt {
  const schema = OUTPUT_SCHEMAS[template.agent];
  const jsonSchema = toStrictJsonSchema(schema);
  const schemaHash = sha256Hex(JSON.stringify(jsonSchema));
  const text = [
    SECURITY_PREAMBLE,
    template.system,
    template.task,
    `[output-schema ${template.outputSchemaId} sha256:${schemaHash}]`,
  ].join('\n\n');
  if (text.length > MAX_TEMPLATE_CHARS) {
    throw new Error(
      `Prompt ${template.agent}@${template.version} exceeds ${MAX_TEMPLATE_CHARS} characters`,
    );
  }
  return Object.freeze({
    ...template,
    id: `prompt_${template.agent}_${template.version}`,
    template: text,
    templateHash: sha256Hex(text),
    schemaHash,
    systemMessage: [SECURITY_PREAMBLE, template.system].join('\n\n'),
    jsonSchema: Object.freeze(jsonSchema),
    templateShingles: wordShingles(text, 6),
  });
}

class ImmutablePromptRegistry implements PromptRegistry {
  private readonly byId: ReadonlyMap<string, RegisteredPrompt>;

  constructor(prompts: readonly RegisteredPrompt[]) {
    this.byId = new Map(prompts.map((p) => [p.id, p]));
  }

  get(agent: AgentName, version?: string): RegisteredPrompt {
    if (version !== undefined) {
      const exact = this.byId.get(`prompt_${agent}_${version}`);
      if (!exact) throw new Error(`No prompt registered for ${agent}@${version}`);
      return exact;
    }
    const active = [...this.byId.values()]
      .filter((p) => p.agent === agent && p.status === 'active')
      .sort((a, b) => compareSemver(b.version, a.version));
    const latest = active[0];
    if (!latest) throw new Error(`No active prompt registered for ${agent}`);
    return latest;
  }

  list(): readonly RegisteredPrompt[] {
    return [...this.byId.values()].sort(
      (a, b) => a.agent.localeCompare(b.agent) || compareSemver(a.version, b.version),
    );
  }

  with(template: PromptTemplate): PromptRegistry {
    const next = register(template);
    const existing = this.byId.get(next.id);
    if (existing && existing.templateHash !== next.templateHash) {
      throw new Error(
        `Prompt ${next.agent}@${next.version} is already published with different content; bump the version instead of editing it`,
      );
    }
    return new ImmutablePromptRegistry([...this.byId.values(), next]);
  }

  toRecords(meta: PromptRecordMeta): PromptVersion[] {
    return this.list().map((p) =>
      PromptVersionSchema.parse({
        tenantId: meta.tenantId,
        createdAt: meta.now,
        updatedAt: meta.now,
        createdBy: meta.createdBy,
        id: p.id,
        agent: p.agent,
        version: p.version,
        templateHash: p.templateHash,
        template: p.template,
        outputSchemaId: p.outputSchemaId,
        status: p.status,
        changeNote: p.changeNote,
      }),
    );
  }
}

/** Builds a registry from templates (defaults to the built-in, reviewed set). */
export function createPromptRegistry(
  templates: readonly PromptTemplate[] = PROMPT_TEMPLATES,
): PromptRegistry {
  const registered = templates.map(register);
  const ids = new Set<string>();
  for (const p of registered) {
    if (ids.has(p.id)) throw new Error(`Duplicate prompt ${p.agent}@${p.version}`);
    ids.add(p.id);
  }
  return new ImmutablePromptRegistry(registered);
}
