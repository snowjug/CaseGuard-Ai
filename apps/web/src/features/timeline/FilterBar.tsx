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
import { cg, formatDateTimeUtc } from '@caseguard/ui';
import {
  Button,
  Field,
  Menu,
  MenuButton,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Select,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { clipText } from '../../lib/text';
import {
  FLAGS,
  FLAG_LABELS,
  type TimelineFlag,
  type TimelineFilterValues,
} from './timeline-filters';

const useStyles = makeStyles({
  bar: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    padding: cg.space[3],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: cg.space[3] },
  field: { flex: '1 1 180px', minWidth: 0, '& .fui-Select': { width: '100%', minWidth: 0 } },
  group: { display: 'flex', flexWrap: 'wrap', gap: cg.space[1] },
  label: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textMuted,
  },
  status: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
});

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
 * Filters of the timeline: event kind, participant role, evidence category, hypothesis (applied by the server), the
 * delay, repeat and fork highlights and the zoom window. Everything is in the URL.
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

  return (
    <form
      role="search"
      aria-label="Filter events"
      className={styles.bar}
      onSubmit={(event) => event.preventDefault()}
    >
      <div className={styles.row}>
        <Menu
          checkedValues={{ types: filters.types }}
          onCheckedValueChange={(_event, data) =>
            onChange({ types: data.checkedItems as EventType[] })
          }
        >
          <MenuTrigger disableButtonEnhancement>
            <MenuButton>
              Event kind{filters.types.length > 0 ? ` (${filters.types.length})` : ''}
            </MenuButton>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {EVENT_TYPES.map((type) => (
                <MenuItemCheckbox key={type} name="types" value={type}>
                  {EVENT_TYPE_LABELS[type]}
                </MenuItemCheckbox>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        <Menu
          checkedValues={{ roles: filters.roles }}
          onCheckedValueChange={(_event, data) =>
            onChange({ roles: data.checkedItems as ParticipantRole[] })
          }
        >
          <MenuTrigger disableButtonEnhancement>
            <MenuButton>
              Participant role{filters.roles.length > 0 ? ` (${filters.roles.length})` : ''}
            </MenuButton>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {PARTICIPANT_ROLES.map((role) => (
                <MenuItemCheckbox key={role} name="roles" value={role}>
                  {PARTICIPANT_ROLE_LABELS[role]}
                </MenuItemCheckbox>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        <Field label="Evidence category" className={styles.field}>
          <Select
            value={filters.category}
            onChange={(_event, data) =>
              onChange({ category: data.value as TimelineFilterValues['category'] })
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
        <Field label="Hypothesis" className={styles.field}>
          <Select
            value={filters.hyp ?? ''}
            onChange={(_event, data) => onChange({ hyp: data.value || null })}
          >
            <option value="">Any hypothesis</option>
            {hypotheses.map((hypothesis) => (
              <option key={hypothesis.id} value={hypothesis.id}>
                {hypothesis.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className={styles.row}>
        <div role="group" aria-labelledby="timeline-highlights">
          <p id="timeline-highlights" className={styles.label}>
            Show only
          </p>
          <div className={styles.group}>
            {FLAGS.map((flag) => {
              const on = filters.flags.includes(flag);
              return (
                <ToggleButton
                  key={flag}
                  size="small"
                  checked={on}
                  onClick={() =>
                    onChange({
                      flags: on
                        ? filters.flags.filter((item) => item !== flag)
                        : ([...filters.flags, flag] as TimelineFlag[]),
                    })
                  }
                >
                  {FLAG_LABELS[flag]}
                </ToggleButton>
              );
            })}
          </div>
        </div>
        <Field label="Zoom from" className={styles.field}>
          <Select
            value={filters.from ?? ''}
            onChange={(_event, data) => onChange({ from: data.value || null })}
          >
            <option value="">Start of the case</option>
            {zoomOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Zoom to" className={styles.field}>
          <Select
            value={filters.to ?? ''}
            onChange={(_event, data) => onChange({ to: data.value || null })}
          >
            <option value="">End of the case</option>
            {zoomOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button appearance="subtle" disabled={activeCount === 0} onClick={onClear}>
          Clear filters
        </Button>
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
