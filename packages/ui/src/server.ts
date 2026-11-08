/**
 * Server-safe entry (`@caseguard/ui/server`): pure helpers that Server Components may import. The main entry pulls in
 * Fluent UI and React client APIs and must only be imported from Client Components.
 */
export {
  THEME_COOKIE,
  THEME_MODES,
  isThemeMode,
  parseThemeMode,
  readThemeCookie,
  serializeThemeCookie,
  themeColorFor,
  type ThemeMode,
} from './theme/theme-mode';
// The raw design tokens, for the one page that renders without the theme provider (the last-resort error page).
export { palettes, type Palette } from './tokens/palette';
export { radius, space } from './tokens/static';
