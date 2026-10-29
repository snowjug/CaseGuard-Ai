/** Minimal strict parser for the Prometheus text exposition format 0.0.4, used to check conformance. */
export interface ParsedSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface ParsedFamily {
  readonly name: string;
  readonly help: string | undefined;
  readonly type: string | undefined;
  readonly samples: ParsedSample[];
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function parseValue(text: string): number {
  if (text === 'NaN') return Number.NaN;
  if (text === '+Inf') return Number.POSITIVE_INFINITY;
  if (text === '-Inf') return Number.NEGATIVE_INFINITY;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`Invalid sample value "${text}"`);
  return value;
}

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let index = 0;
  while (index < text.length) {
    const equals = text.indexOf('=', index);
    if (equals === -1) throw new Error(`Malformed labels: ${text}`);
    const name = text.slice(index, equals);
    if (!LABEL_NAME.test(name)) throw new Error(`Invalid label name "${name}"`);
    if (text.charAt(equals + 1) !== '"') throw new Error(`Label value must be quoted: ${text}`);
    let value = '';
    let cursor = equals + 2;
    for (;;) {
      const char = text.charAt(cursor);
      if (char === '') throw new Error(`Unterminated label value: ${text}`);
      if (char === '\\') {
        const next = text.charAt(cursor + 1);
        if (next === 'n') value += '\n';
        else if (next === '\\' || next === '"') value += next;
        else throw new Error(`Invalid escape \\${next}`);
        cursor += 2;
        continue;
      }
      if (char === '"') break;
      if (char === '\n') throw new Error('Raw newline inside label value');
      value += char;
      cursor += 1;
    }
    if (name in labels) throw new Error(`Duplicate label "${name}"`);
    labels[name] = value;
    index = cursor + 1;
    if (text.charAt(index) === ',') index += 1;
    else if (index < text.length) throw new Error(`Expected comma at ${index} in ${text}`);
  }
  return labels;
}

function unescapeHelp(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text.charAt(i + 1);
    if (next === 'n') out += '\n';
    else if (next === '\\') out += '\\';
    else throw new Error(`Invalid HELP escape \\${next}`);
    i += 1;
  }
  return out;
}

export function parsePrometheus(text: string): ParsedFamily[] {
  if (text === '') return [];
  if (!text.endsWith('\n')) throw new Error('Exposition must end with a newline');
  const families = new Map<string, { help?: string; type?: string; samples: ParsedSample[] }>();
  const familyOf = (name: string) => {
    let family = families.get(name);
    if (family === undefined) {
      family = { samples: [] };
      families.set(name, family);
    }
    return family;
  };
  for (const line of text.slice(0, -1).split('\n')) {
    if (line === '') throw new Error('Empty line in exposition');
    if (line.startsWith('# HELP ')) {
      const rest = line.slice('# HELP '.length);
      const space = rest.indexOf(' ');
      const name = space === -1 ? rest : rest.slice(0, space);
      if (!NAME.test(name)) throw new Error(`Invalid HELP name "${name}"`);
      const family = familyOf(name);
      if (family.help !== undefined) throw new Error(`Duplicate HELP for ${name}`);
      family.help = unescapeHelp(space === -1 ? '' : rest.slice(space + 1));
      continue;
    }
    if (line.startsWith('# TYPE ')) {
      const [name, type, extra] = line.slice('# TYPE '.length).split(' ');
      if (name === undefined || type === undefined || extra !== undefined)
        throw new Error(`Malformed TYPE: ${line}`);
      if (!NAME.test(name)) throw new Error(`Invalid TYPE name "${name}"`);
      if (!['counter', 'gauge', 'histogram', 'summary', 'untyped'].includes(type))
        throw new Error(`Bad type ${type}`);
      const family = familyOf(name);
      if (family.type !== undefined) throw new Error(`Duplicate TYPE for ${name}`);
      family.type = type;
      continue;
    }
    if (line.startsWith('#')) continue;
    const brace = line.indexOf('{');
    const lastSpace = line.lastIndexOf(' ');
    if (lastSpace === -1) throw new Error(`Malformed sample: ${line}`);
    let name: string;
    let labels: Record<string, string> = {};
    if (brace !== -1 && brace < lastSpace) {
      name = line.slice(0, brace);
      const close = line.lastIndexOf('}', lastSpace);
      if (close === -1) throw new Error(`Unclosed labels: ${line}`);
      labels = parseLabels(line.slice(brace + 1, close));
    } else {
      name = line.slice(0, lastSpace);
    }
    if (!NAME.test(name)) throw new Error(`Invalid sample name "${name}"`);
    const sample: ParsedSample = { name, labels, value: parseValue(line.slice(lastSpace + 1)) };
    const base = [...families.keys()].find(
      (candidate) =>
        candidate === name ||
        (families.get(candidate)?.type === 'histogram' &&
          [`${candidate}_bucket`, `${candidate}_sum`, `${candidate}_count`].includes(name)),
    );
    if (base === undefined) throw new Error(`Sample ${name} appears before its HELP/TYPE`);
    familyOf(base).samples.push(sample);
  }
  return [...families.entries()].map(([name, family]) => ({
    name,
    help: family.help,
    type: family.type,
    samples: family.samples,
  }));
}
