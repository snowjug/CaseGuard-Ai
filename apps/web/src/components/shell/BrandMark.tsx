import { cg } from '@caseguard/ui';

/** CaseGuard mark: three connected nodes (evidence, a decision fork, a hypothesis) on the brand colour. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill={cg.tone.brand.solid} />
      <path
        d="M8.5 21.5L15.5 11L24 18.2"
        fill="none"
        stroke={cg.tone.brand.onSolid}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      <circle cx="8.5" cy="21.5" r="3.2" fill={cg.tone.brand.onSolid} />
      <path d="M15.5 6.6L19.9 11L15.5 15.4L11.1 11Z" fill={cg.tone.brand.onSolid} />
      <path d="M24 14.6L27 16.4V20L24 21.8L21 20V16.4Z" fill={cg.tone.brand.onSolid} />
    </svg>
  );
}
