'use client';

import {
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  EVIDENCE_CATEGORIES,
  EVIDENCE_CATEGORY_LABELS,
  PARTICIPANT_ROLES,
  PARTICIPANT_ROLE_LABELS,
  type EventType,
  type ParticipantRole,
  type TimelineEvent,
} from '@caseguard/schemas';
import { Button, Field, Select, borderColors, cg, formatDateTimeUtc } from '@caseguard/ui';
import { Checkbox, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { GitForkIcon, HourglassIcon, RepeatIcon, type LucideIcon } from 'lucide-react';
import { clipText } from '../../lib/text';
import { FilterPopover } from '../evidence/FilterPopover';
import {
  FLAGS,
  FLAG_LABELS,
  type TimelineFilterValues,
  type TimelineFlag,
} from './timeline-filters';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[2], margin: 0 },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  lead: {
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  chips: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  pressed: {
    backgroundColor: cg.tone.brand.tint,
    color: cg.tone.brand.fg,
    ...borderColors(cg.tone.brand.border),
  },
  spacer: { flex: '1 1 0' },
  status: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  group: { margin: 0, padding: 0, border: 0, minWidth: 0 },
  legend: {
    padding: 0,
    marginBottom: cg.space[1],
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  options: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    alignItems: 'start',
    columnGap: cg.space[2],
  },
});

const FLAG_ICONS: Record<TimelineFlag, LucideIcon> = {
  delay: HourglassIcon,
  repeat: RepeatIcon,
  fork: GitForkIcon,
};

export interface FilterBarProps {
  filters: TimelineFilterValues;
  onChange: (patch: Partial<TimelineFilterValues>) => void;
  onClear: () => void;
  activeCount: number;
  hypotheses: readonly { id: string; name: string }[];
  /** Loaded events, the choices for the zoom window. */
  events: readonly Pick<TimelineEvent, 'id' | 'timestamp' | 'title' | 'type'>[];
  shown: number;
  total: number | undefined;
  hasMore: boolean;
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${clipText(text, max - 1)}…` : text;

/**
 * Filters of the timeline in one row: the three highlights (delays, repeated diagnostics, key decisions) as toggles, and
 * everything else (event kind, who, evidence category, possible cause and the zoom window) in a popover that says how
 * many of its filters are on. Everything is in the URL.
 */
export function FilterBar({
  filters,
  onChange,
  onClear,
  activeCount,
  hypotheses,
  events,
  shown,
  total,
  hasMore,
}: FilterBarProps) {
  const styles = useStyles();
  const zoomOptions = [
    ...events.map((event) => ({
      value: event.timestamp,
      label: `${formatDateTimeUtc(event.timestamp)} · ${clip(event.title ?? EVENT_TYPE_LABELS[event.type], 48)}`,
    })),
  ];
  // A zoom bound from a shared link may not be one of the loaded events: keep it selectable rather than silently drop it.
  for (const bound of [filters.from, filters.to]) {
    if (bound && !zoomOptions.some((option) => option.value === bound)) {
      zoomOptions.push({ value: bound, label: formatDateTimeUtc(bound) });
    }
  }
  zoomOptions.sort((a, b) => Date.parse(a.value) - Date.parse(b.value));

  // The filters inside the popover: the highlights are the row's own.
  const popoverCount =
    (filters.types.length > 0 ? 1 : 0) +
    (filters.roles.length > 0 ? 1 : 0) +
    (filters.category !== 'all' ? 1 : 0) +
    (filters.hyp ? 1 : 0) +
    (filters.from || filters.to ? 1 : 0);

  const toggle = <T extends string>(list: readonly T[], value: T, on: boolean): T[] =>
    on ? [...list, value] : list.filter((item) => item !== value);

  return (
    <form
      role="search"
      aria-label="Filter events"
      className={styles.root}
      onSubmit={(event) => event.preventDefault()}
    >
      <div className={styles.row}>
        <div role="group" aria-label="Show only" className={styles.chips}>
          <span className={styles.lead} aria-hidden="true">
            Show only
          </span>
          {FLAGS.map((flag) => {
            const on = filters.flags.includes(flag);
            const Icon = FLAG_ICONS[flag];
            return (
              <Button
                key={flag}
                size="sm"
                variant={on ? 'secondary' : 'ghost'}
                className={mergeClasses(on && styles.pressed)}
                icon={<Icon />}
                aria-pressed={on}
                onClick={() =>
                  onChange({
                    flags: on
                      ? filters.flags.filter((item) => item !== flag)
                      : ([...filters.flags, flag] as TimelineFlag[]),
                  })
                }
              >
                {FLAG_LABELS[flag]}
              </Button>
            );
          })}
        </div>
        <span className={styles.spacer} />
        <FilterPopover activeCount={popoverCount}>
          <fieldset className={styles.group}>
            <legend className={styles.legend}>
              Event kind{filters.types.length > 0 ? ` (${filters.types.length})` : ''}
            </legend>
            <div className={styles.options}>
              {EVENT_TYPES.map((type) => (
                <Checkbox
                  key={type}
                  label={EVENT_TYPE_LABELS[type]}
                  checked={filters.types.includes(type)}
                  onChange={(_event, data) =>
                    onChange({
                      types: toggle<EventType>(filters.types, type, data.checked === true),
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.group}>
            <legend className={styles.legend}>
              Participant role{filters.roles.length > 0 ? ` (${filters.roles.length})` : ''}
            </legend>
            <div className={styles.options}>
              {PARTICIPANT_ROLES.map((role) => (
                <Checkbox
                  key={role}
                  label={PARTICIPANT_ROLE_LABELS[role]}
                  checked={filters.roles.includes(role)}
                  onChange={(_event, data) =>
                    onChange({
                      roles: toggle<ParticipantRole>(filters.roles, role, data.checked === true),
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
          <Field label="Evidence category">
            <Select
              value={filters.category}
              onChange={(event) =>
                onChange({ category: event.target.value as TimelineFilterValues['category'] })
              }
            >
              <option value="all">Any category</option>
              {EVIDENCE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {EVIDENCE_CATEGORY_LABELS[category]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Possible cause">
            <Select
              value={filters.hyp ?? ''}
              onChange={(event) => onChange({ hyp: event.target.value || null })}
            >
              <option value="">Any cause</option>
              {hypotheses.map((hypothesis) => (
                <option key={hypothesis.id} value={hypothesis.id}>
                  {hypothesis.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Zoom from">
            <Select
              value={filters.from ?? ''}
              onChange={(event) => onChange({ from: event.target.value || null })}
            >
              <option value="">Start of the case</option>
              {zoomOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Zoom to">
            <Select
              value={filters.to ?? ''}
              onChange={(event) => onChange({ to: event.target.value || null })}
            >
              <option value="">End of the case</option>
              {zoomOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </FilterPopover>
        {activeCount > 0 ? (
          <Button variant="ghost" onClick={onClear}>
            Clear filters
          </Button>
        ) : null}
      </div>
      <p className={styles.status} role="status" aria-live="polite">
        {total === undefined
          ? 'Loading events…'
          : `Showing ${shown} of ${total} ${total === 1 ? 'event' : 'events'}${
              hasMore ? ' (loading more as you scroll)' : ''
            }${activeCount > 0 ? `, ${activeCount} ${activeCount === 1 ? 'filter' : 'filters'} on` : ''}.`}
      </p>
    </form>
  );
}
