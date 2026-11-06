'use client';

import { Badge } from '@caseguard/ui';
import { HistoryIcon } from 'lucide-react';

/**
 * The label every retrospective frame carries: it says the content below uses the finished case, including its outcome,
 * and that nothing the engine generated at decision time was built from it. The technical word is in the tooltip.
 */
export function HindsightBadge() {
  return (
    <div>
      <Badge
        tone="neutral"
        icon={<HistoryIcon />}
        dashed
        title="Hindsight: uses the finished case, including its outcome. Nothing the engine generated at decision time was built from it."
      >
        Known only later
      </Badge>
    </div>
  );
}
