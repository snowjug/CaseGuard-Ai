import type { EventType } from '@caseguard/schemas';
import {
  ArrowReplyRegular,
  ArrowSwapRegular,
  ArrowUpRegular,
  CallRegular,
  CheckmarkCircleRegular,
  DesktopRegular,
  DocumentSearchRegular,
  DocumentTextRegular,
  MailRegular,
  NoteRegular,
  ShieldCheckmarkRegular,
  TableRegular,
  WrenchRegular,
  type FluentIcon,
} from '@fluentui/react-icons';

/** One icon per kind of event; the kind is always also written out, so the icon is only a visual anchor. */
export const EVENT_TYPE_ICONS: Record<EventType, FluentIcon> = {
  customer_email: MailRegular,
  customer_call: CallRegular,
  engineer_email: MailRegular,
  case_note: NoteRegular,
  engineer_action: WrenchRegular,
  diagnostic_result: DocumentSearchRegular,
  log_sample: DocumentTextRegular,
  query_output: TableRegular,
  escalation: ArrowUpRegular,
  escalation_response: ArrowReplyRegular,
  status_change: ArrowSwapRegular,
  resolution_note: CheckmarkCircleRegular,
  validation_result: ShieldCheckmarkRegular,
  system_event: DesktopRegular,
};
