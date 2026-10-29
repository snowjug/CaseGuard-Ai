import type { CaseEvent } from '@caseguard/schemas';

/** Position of each event id in an ordered event list. */
export const positionsOf = (events: readonly CaseEvent[]): Map<string, number> =>
  new Map(events.map((event, index) => [event.id, index]));

/**
 * Position of a referenced event when it lies strictly before `index`; null for unknown, later or
 * self references. A reply can only answer something that already existed, so a forward reference
 * must never let a later event change how an earlier one is read: that would make an analysis of a
 * prefix differ from the full analysis restricted to that prefix.
 */
export function earlierPosition(
  positions: ReadonlyMap<string, number>,
  referencedId: string | null | undefined,
  index: number,
): number | null {
  if (!referencedId) return null;
  const position = positions.get(referencedId);
  return position !== undefined && position < index ? position : null;
}

/**
 * Direct answers to every event (`inResponseTo`), indexed once so that a closure costs time
 * proportional to the size of the answer tree instead of a scan of the whole case per call.
 */
export class ResponderIndex {
  private readonly children = new Map<string, CaseEvent[]>();

  /** `events` must be in sequence order, as every temporal view and normalised case guarantees. */
  constructor(events: readonly CaseEvent[]) {
    const positions = positionsOf(events);
    events.forEach((event, index) => {
      const parent = event.inResponseTo;
      if (parent === null || earlierPosition(positions, parent, index) === null) return;
      const list = this.children.get(parent);
      if (list) list.push(event);
      else this.children.set(parent, [event]);
    });
  }

  /** Events that answer `eventId`, transitively and in breadth-first order. */
  closure(eventId: string): CaseEvent[] {
    const out: CaseEvent[] = [];
    const seen = new Set<string>([eventId]);
    const queue: string[] = [eventId];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      if (current === undefined) continue;
      for (const child of this.children.get(current) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        queue.push(child.id);
      }
    }
    return out;
  }
}
