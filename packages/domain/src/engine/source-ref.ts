import type { CaseEvent, SourceField } from '@caseguard/schemas';

/**
 * JSON pointer to the stored text a source reference's offsets count into: the title, the body, or
 * (for a span that crosses the line break between them, and for a reference with no offsets) the
 * event itself.
 */
export function sourcePointerFor(
  event: Pick<CaseEvent, 'sourcePointer'>,
  field: SourceField | null,
): string {
  if (field === 'title') return `${event.sourcePointer}/title`;
  if (field === 'body') return `${event.sourcePointer}/body`;
  return event.sourcePointer;
}
