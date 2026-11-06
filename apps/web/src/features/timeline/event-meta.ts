import type { EventType } from '@caseguard/schemas';
import {
  ArrowLeftRightIcon,
  ArrowUpIcon,
  CircleCheckIcon,
  FileSearchIcon,
  FileTextIcon,
  MailIcon,
  MonitorIcon,
  PhoneIcon,
  ReplyIcon,
  ShieldCheckIcon,
  StickyNoteIcon,
  TableIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';

/** One icon per kind of event; the kind is always also written out, so the icon is only a visual anchor. */
export const EVENT_TYPE_ICONS: Record<EventType, LucideIcon> = {
  customer_email: MailIcon,
  customer_call: PhoneIcon,
  engineer_email: MailIcon,
  case_note: StickyNoteIcon,
  engineer_action: WrenchIcon,
  diagnostic_result: FileSearchIcon,
  log_sample: FileTextIcon,
  query_output: TableIcon,
  escalation: ArrowUpIcon,
  escalation_response: ReplyIcon,
  status_change: ArrowLeftRightIcon,
  resolution_note: CircleCheckIcon,
  validation_result: ShieldCheckIcon,
  system_event: MonitorIcon,
};
