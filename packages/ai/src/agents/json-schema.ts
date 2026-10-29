import { z } from 'zod';

export type JsonSchemaObject = Record<string, unknown>;

/** Keywords strict structured output does not accept; our own validation enforces these bounds. */
const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'default',
  '$schema',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keywords whose value is a map of name -> schema (names must never be filtered as keywords). */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
]);

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, strictify(sub)]),
      );
    } else {
      out[key] = strictify(value);
    }
  }
  const properties = out.properties;
  if (isRecord(properties)) {
    out.additionalProperties = false;
    out.required = Object.keys(properties);
  }
  return out;
}

/**
 * Converts a Zod schema into the strict JSON Schema subset accepted by Azure OpenAI structured
 * output: every object lists all properties as required, forbids extra keys and carries no length
 * or range keywords.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchemaObject {
  const raw = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'output',
    unrepresentable: 'any',
    reused: 'inline',
  });
  const result = strictify(raw);
  if (!isRecord(result)) throw new Error('Output schema did not convert to a JSON object schema');
  return result;
}

/** Walks a strict schema and returns the paths that violate the strict-mode rules (for tests). */
export function findStrictViolations(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => findStrictViolations(item, `${path}[${i}]`));
  }
  if (!isRecord(node)) return [];
  const problems: string[] = [];
  for (const key of Object.keys(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) problems.push(`${path}.${key} is not supported`);
  }
  const properties = node.properties;
  if (isRecord(properties)) {
    if (node.additionalProperties !== false) {
      problems.push(`${path} must set additionalProperties=false`);
    }
    const required = Array.isArray(node.required) ? node.required : [];
    for (const name of Object.keys(properties)) {
      if (!required.includes(name)) problems.push(`${path}.${name} must be required`);
    }
    for (const [name, sub] of Object.entries(properties)) {
      problems.push(...findStrictViolations(sub, `${path}.properties.${name}`));
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'properties') problems.push(...findStrictViolations(value, `${path}.${key}`));
  }
  return problems;
}
