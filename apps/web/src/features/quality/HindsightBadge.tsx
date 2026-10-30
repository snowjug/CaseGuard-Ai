'use client';

import { BadgeShell } from '@caseguard/ui';
import { HistoryRegular } from '@fluentui/react-icons';

/**
 * The label every retrospective frame carries: it says the content below uses the finished case, including its outcome,
 * and that nothing the engine generated at decision time was built from it. Same wording and look as the recorded
 * resolution on the case overview and the hindsight check in the Counterfactual Lab, so one label means one thing.
 */
export function HindsightBadge() {
  return (
    <div>
      <BadgeShell
        tone="neutral"
        pattern="hatch"
        icon={<HistoryRegular />}
        label="Hindsight (not used to generate)"
        size="medium"
        borderStyle="dashed"
      />
    </div>
  );
}
