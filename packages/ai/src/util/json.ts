export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/**
 * Parses model text as JSON. Only a surrounding markdown fence is tolerated; truncated or otherwise
 * malformed text is reported (without echoing it) so the orchestrator can repair or fall back.
 */
export function parseModelJson(text: string): JsonParseResult {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.length === 0) return { ok: false, error: 'Model returned empty output.' };
  const unfenced = FENCE.exec(trimmed)?.[1] ?? trimmed;
  try {
    return { ok: true, value: JSON.parse(unfenced) as unknown };
  } catch (error) {
    const detail = error instanceof SyntaxError ? 'syntax error' : 'unreadable';
    return { ok: false, error: `Model output is not valid JSON (${detail}).` };
  }
}
