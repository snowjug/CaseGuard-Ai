import type { BrandVariants } from '@fluentui/react-components';

/**
 * CaseGuard brand ramp: one calm violet-indigo (hue 249). Shade 80 (#5B46D6) is the anchor and keeps 6.4:1 with white,
 * so primary buttons (white text on `colorBrandBackground`) meet WCAG AA in the light theme; the dark theme replaces the
 * brand backgrounds with lighter shades (see `themes.ts`) so the filled shape stays visible against dark surfaces.
 */
export const caseguardBrand: BrandVariants = {
  10: '#090718',
  20: '#100B2D',
  30: '#191046',
  40: '#211660',
  50: '#2A1C7D',
  60: '#35239F',
  70: '#422BC5',
  80: '#5B46D6',
  90: '#725FE3',
  100: '#8C7BEA',
  110: '#A79AEF',
  120: '#BEB4F3',
  130: '#D5CFF7',
  140: '#E5E1F9',
  150: '#F0EEFC',
  160: '#F8F7FD',
};
