import type { ParticipantRole } from '@caseguard/schemas';
import type { DraftSpeaker } from './draft-types';
import type { RoleInference, SpeakerLabel } from './roles';
import { displayValue, labelKey, type WarningCollector } from './text';

/** Slots kept free so that, once individual speakers run out, one shared speaker per role fits. */
const RESERVED_SHARED_SLOTS = 8;

/**
 * Registry of the distinct speakers of one parse. The same person is recognised by e-mail
 * address, or by role plus normalised name, so "Support Engineer <a@x.invalid>" in a header and
 * "Support Engineer" on a chat line are one participant. Beyond the participant limit the rest
 * are merged into one speaker per role instead of failing, and that is reported.
 */
export class SpeakerBook {
  readonly speakers = new Map<string, DraftSpeaker>();
  merged = false;
  private individual = 0;
  private readonly individualCap: number;
  private readonly byAddress = new Map<string, DraftSpeaker>();
  private readonly byName = new Map<string, DraftSpeaker>();
  private readonly addressesOf = new Map<DraftSpeaker, Set<string>>();

  constructor(maxParticipants: number) {
    this.individualCap = Math.max(0, maxParticipants - RESERVED_SHARED_SLOTS);
  }

  register(
    label: SpeakerLabel,
    inference: RoleInference,
    at: number,
    warnings: WarningCollector,
  ): DraftSpeaker {
    const unidentified = inference.basis === 'unknown';
    const bucket = unidentified ? 'unknown' : inference.role;
    const nameKey = labelKey(label.name) || (label.address ? '' : 'unnamed');
    const existing = this.find(bucket, nameKey, label.address);
    if (existing) return existing;

    if (this.individual >= this.individualCap) {
      const sharedKey = `${bucket}|*`;
      const shared = this.speakers.get(sharedKey);
      if (shared) return shared;
      if (!this.merged) {
        warnings.add(
          'speakers_merged',
          'warning',
          'There are too many distinct speakers; the remaining ones were merged into one participant per role.',
          { hint: 'Use consistent speaker labels.', line: at },
        );
      }
      this.merged = true;
      return this.add(sharedKey, 'multiple speakers', inference, unidentified);
    }

    this.individual += 1;
    const speaker = this.add(
      `${bucket}|${this.speakers.size}`,
      displayValue(label.raw, 60),
      inference,
      unidentified,
    );
    const addresses = new Set<string>();
    this.addressesOf.set(speaker, addresses);
    if (nameKey) this.byName.set(`${bucket}|${nameKey}`, speaker);
    if (label.address) {
      addresses.add(label.address);
      this.byAddress.set(`${bucket}|${label.address}`, speaker);
    }
    this.explain(label, inference, at, warnings);
    return speaker;
  }

  private find(bucket: string, nameKey: string, address: string | null): DraftSpeaker | undefined {
    if (address) {
      const byAddress = this.byAddress.get(`${bucket}|${address}`);
      if (byAddress) return byAddress;
    }
    if (!nameKey) return undefined;
    const byName = this.byName.get(`${bucket}|${nameKey}`);
    if (!byName) return undefined;
    const known = this.addressesOf.get(byName) ?? new Set<string>();
    // Two different addresses behind one generic label ("Support Engineer") are two people.
    if (address && known.size > 0 && !known.has(address)) return undefined;
    if (address) {
      known.add(address);
      this.byAddress.set(`${bucket}|${address}`, byName);
    }
    return byName;
  }

  private add(
    key: string,
    label: string,
    inference: RoleInference,
    unidentified: boolean,
  ): DraftSpeaker {
    const role: ParticipantRole = inference.role;
    const speaker: DraftSpeaker = { key, label, role, roleBasis: inference.basis, unidentified };
    this.speakers.set(key, speaker);
    return speaker;
  }

  private explain(
    label: SpeakerLabel,
    inference: RoleInference,
    at: number,
    warnings: WarningCollector,
  ): void {
    const shown = displayValue(label.raw, 50);
    if (inference.basis === 'unknown') {
      warnings.add(
        'role_unknown',
        'warning',
        `Could not tell whether "${shown}" is a customer or an engineer; recorded as an unidentified participant.`,
        {
          hint: 'Add a role word to the label, for example "Anna (customer admin)" or "Anna (support engineer)".',
          line: at,
        },
      );
    } else if (inference.ambiguous) {
      warnings.add(
        'role_ambiguous',
        'warning',
        `"${shown}" contains words from both sides of the case; it was recorded as ${inference.role.replace(/_/g, ' ')}.`,
        {
          hint: 'Use a clearer label, for example "Customer admin" or "Support engineer".',
          line: at,
        },
      );
    } else if (inference.basis === 'generic_customer') {
      warnings.add(
        'role_generalised',
        'info',
        `"${shown}" was recorded as a customer admin (the closest customer role).`,
        { hint: 'Say "end user" or "network admin" in the label to be more specific.', line: at },
      );
    }
  }
}
