import { buildCustomTokens, palettes, radius, space } from '@caseguard/ui';

/**
 * The stylesheet of the report, for reading in the app, for print and for the downloaded file. Plain CSS over the same
 * design variables (`--cg…`) the app defines, so in the app it follows the theme; the downloaded file carries the light
 * values itself, and print always uses them so the page prints in ink, not in dark mode.
 *
 * It is a constant: no case text ever goes into it, which is why it may be written into a `<style>` element as it is.
 */

/** The paper palette: print is ink on white whatever the theme, so these four values are fixed on purpose. */
const PAPER = { page: '#fff', ink: '#000', rule: '#777', frame: '#999' } as const;

const px = (value: number): string => `${value}px`;
const R = {
  sm: px(radius.sm),
  md: px(radius.md),
  lg: px(radius.lg),
  xl: px(radius.xl),
  pill: px(radius.pill),
};
const S = {
  s1: px(space[1]),
  s2: px(space[2]),
  s3: px(space[3]),
  s4: px(space[4]),
  s6: px(space[6]),
  s8: px(space[8]),
};

const lightVariables = Object.entries(buildCustomTokens(palettes.light))
  .map(([name, value]) => `--${name}:${value}`)
  .join(';');

/** The variables the downloaded file needs, since it is not inside the app's theme. */
export const STANDALONE_VARIABLES = `:root{${lightVariables};color-scheme:light}`;

const BASE = `
.cg-report{max-width:880px;margin:0 auto;color:var(--cgText);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
.cg-report *,.cg-report *::before,.cg-report *::after{box-sizing:border-box}
.cg-report h1{margin:.25rem 0 .5rem;font-size:1.75rem;line-height:1.2;font-weight:700}
.cg-report h2{margin:0 0 .75rem;font-size:1.3rem;line-height:1.25;font-weight:700}
.cg-report h3{margin:1.1rem 0 .4rem;font-size:1.05rem;line-height:1.3;font-weight:650}
.cg-report h4{margin:.8rem 0 .3rem;font-size:.95rem;font-weight:650}
.cg-report p{margin:.4rem 0}
.cg-report ul,.cg-report ol{margin:.4rem 0;padding-left:1.4rem}
.cg-report li{margin:.25rem 0}
.cg-report a{color:var(--cgTextLink);text-underline-offset:2px}
.cg-report a:focus-visible,.cg-report .cg-strip-wrap:focus-visible{outline:3px solid var(--cgFocus);outline-offset:2px}
.cg-report :target{scroll-margin-top:calc(var(--cg-shell-top,0px) + ${S.s6})}
.cg-report small,.cg-muted{color:var(--cgTextSecondary)}
.cg-print-only{display:none}
.cg-eyebrow{margin:0;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:var(--cgTextSecondary);font-weight:600}
.cg-head{padding:${S.s1} 0 ${S.s3}}
.cg-tags{display:flex;flex-wrap:wrap;gap:.4rem;margin:.5rem 0}
.cg-tag{display:inline-block;padding:.05rem .6rem;border:1px solid var(--cgBorderControl);border-radius:${R.pill};font-size:.8rem;font-weight:600;color:var(--cgTextSecondary);background:var(--cgSurface);white-space:nowrap}
.cg-tag--estimated{border-style:dotted}
.cg-tag--simulated{border-style:dashed;border-color:var(--cgToneSimulatedBorder);color:var(--cgToneSimulatedFg);background:var(--cgToneSimulatedTint)}
.cg-tag--good{border-color:var(--cgToneProductiveBorder);color:var(--cgToneProductiveFg);background:var(--cgToneProductiveTint)}
.cg-tag--warn{border-color:var(--cgToneUncertainBorder);color:var(--cgToneUncertainFg);background:var(--cgToneUncertainTint)}
.cg-tag--bad{border-color:var(--cgToneUnsupportedBorder);color:var(--cgToneUnsupportedFg);background:var(--cgToneUnsupportedTint)}
.cg-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.2rem 1.25rem;margin:.6rem 0}
.cg-facts dt{color:var(--cgTextSecondary)}
.cg-facts dd{margin:0}
.cg-contents{margin:${S.s3} 0;padding:${S.s3} ${S.s4};border:1px solid var(--cgBorderSubtle);border-radius:${R.md};background:var(--cgSurfaceSunken)}
.cg-contents h2{margin:0 0 .3rem;font-size:1rem}
.cg-contents ol{margin:0;columns:2;column-gap:2rem}
.cg-sec{margin:${S.s4} 0;padding:${S.s6};border:1px solid var(--cgBorderSubtle);border-radius:${R.md};background:var(--cgSurface)}
.cg-sec>h2 .cg-num{display:inline-block;min-width:1.7em;margin-right:.35rem;color:var(--cgTextSecondary);font-weight:600}
.cg-callout{margin:.7rem 0;padding:.6rem .9rem;border:1px solid var(--cgBorderControl);border-left-width:4px;border-radius:${R.sm};background:var(--cgSurfaceSunken)}
.cg-callout>:first-child{margin-top:0}
.cg-callout>:last-child{margin-bottom:0}
.cg-callout--sim{border-style:dashed;border-color:var(--cgToneSimulatedBorder);background:var(--cgToneSimulatedTint);color:var(--cgToneSimulatedFg)}
.cg-callout--warn{border-color:var(--cgToneUncertainBorder);background:var(--cgToneUncertainTint);color:var(--cgToneUncertainFg)}
.cg-leftout{border-color:var(--cgToneUncertainBorder);background:var(--cgToneUncertainTint);color:var(--cgToneUncertainFg)}
.cg-lead{font-size:1.1rem;font-weight:600}
.cg-range{position:relative;height:14px;margin:.6rem 0 1.4rem;border-radius:${R.pill};background:var(--cgSurfaceSunken);border:1px solid var(--cgBorderControl)}
.cg-range__band{position:absolute;top:-1px;bottom:-1px;border-radius:${R.pill};background:var(--cgToneUncertainTint);border:2px dotted var(--cgToneUncertainBorder)}
.cg-range__mark{position:absolute;top:-5px;width:4px;height:22px;margin-left:-2px;border-radius:${R.pill};background:var(--cgText)}
.cg-range__scale{position:absolute;top:18px;left:0;right:0;display:flex;justify-content:space-between;font-size:.75rem;color:var(--cgTextSecondary)}
.cg-table{width:100%;border-collapse:collapse;margin:.6rem 0;font-size:.95rem}
.cg-table caption{padding:0 0 .4rem;text-align:left;font-weight:650}
.cg-table th,.cg-table td{padding:.45rem .6rem;border-bottom:1px solid var(--cgBorderSubtle);text-align:left;vertical-align:top}
.cg-table thead th{border-bottom:2px solid var(--cgBorderControl)}
.cg-table .cg-sim{background:var(--cgToneSimulatedTint)}
.cg-table-wrap{overflow-x:auto}
.cg-list{margin:.5rem 0;padding:0;list-style:none}
.cg-item{margin:.6rem 0;padding:.7rem .9rem;border:1px solid var(--cgBorderSubtle);border-radius:${R.md};background:var(--cgSurface)}
.cg-item>h3{margin:.35rem 0 .25rem}
.cg-item p{margin:.25rem 0}
.cg-meta{font-size:.85rem;color:var(--cgTextSecondary)}
.cg-evidence{margin:.35rem 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:.3rem .5rem}
.cg-evidence li{margin:0;padding:.05rem .55rem;border:1px solid var(--cgToneEvidenceBorder);border-radius:${R.pill};background:var(--cgToneEvidenceTint);color:var(--cgToneEvidenceFg);font-size:.82rem}
.cg-general{display:inline-block;margin:.35rem 0;padding:.05rem .6rem;border:1px dashed var(--cgBorderControl);border-radius:${R.pill};font-size:.82rem;color:var(--cgTextSecondary)}
.cg-quote{margin:.4rem 0;padding:.3rem .8rem;border-left:4px solid var(--cgBorderControl);color:var(--cgTextSecondary)}
.cg-strip-wrap{margin:.6rem 0;border:1px solid var(--cgBorderSubtle);border-radius:${R.md};background:var(--cgSurface);overflow-x:auto}
.cg-strip{display:block;width:100%;min-width:640px;height:auto}
.cg-strip text{font-family:inherit}
.cg-strip__row-alt{fill:var(--cgSurfaceSunken)}
.cg-strip__row{fill:var(--cgSurface)}
.cg-strip__label{fill:var(--cgText);font-size:13px;font-weight:600}
.cg-strip__line{stroke:var(--cgBorderSubtle)}
.cg-strip__wait{fill:var(--cgToneUncertainTint);stroke:var(--cgToneUncertainSolid);stroke-dasharray:4 3}
.cg-strip__wait-label{fill:var(--cgToneUncertainFg);font-size:12px;font-weight:600;paint-order:stroke;stroke:var(--cgSurface);stroke-width:3px}
.cg-strip__tick{stroke:var(--cgTextMuted);stroke-width:1.5px;stroke-linecap:round}
.cg-strip__axis{stroke:var(--cgBorderControl)}
.cg-strip__day{fill:var(--cgTextSecondary);font-size:12px}
.cg-m{stroke:var(--cgSurface);stroke-width:1.5px;stroke-linejoin:round}
.cg-m--customer{fill:var(--cgToneEvidenceSolid)}
.cg-m--engineer{fill:var(--cgToneActualSolid)}
.cg-m--system{fill:var(--cgToneNeutralSolid)}
.cg-m--decisions{fill:var(--cgToneForkSolid)}
.cg-m__ring{fill:none;stroke:var(--cgToneProductiveSolid);stroke-width:2px}
.cg-m__num{fill:var(--cgToneForkOnSolid);font-size:12px;font-weight:700}
.cg-legend{display:flex;flex-wrap:wrap;gap:.2rem 1rem;margin:.4rem 0;padding:0;list-style:none;font-size:.85rem;color:var(--cgTextSecondary)}
.cg-legend li{display:inline-flex;align-items:center;gap:.3rem;margin:0}
.cg-timeline{margin:.5rem 0;padding:0;list-style:none}
.cg-timeline li{display:grid;grid-template-columns:11.5rem minmax(0,1fr);gap:.2rem 1rem;margin:0;padding:.45rem 0;border-bottom:1px solid var(--cgBorderSubtle)}
.cg-timeline .cg-when{color:var(--cgTextSecondary);font-size:.9rem}
.cg-timeline .cg-wait{padding:.1rem .6rem;border:1px dashed var(--cgToneUncertainBorder);border-radius:${R.sm};background:var(--cgToneUncertainTint);color:var(--cgToneUncertainFg)}
.cg-foot{margin:${S.s6} 0 ${S.s2};padding-top:${S.s3};border-top:1px solid var(--cgBorderSubtle);font-size:.85rem;color:var(--cgTextSecondary)}
@media screen{
.cg-report{box-sizing:border-box;padding:${S.s8};border:1px solid var(--cgGlassBorder);border-radius:${R.xl};background:var(--cgGlass);box-shadow:inset 0 1px 0 var(--cgHighlight),0 24px 80px -32px var(--cgGlow)}
.cg-sec{margin:${S.s6} 0 0;padding:${S.s6} 0 0;border:0;border-top:1px solid var(--cgBorderSubtle);border-radius:0;background:transparent}
}
@media screen and (max-width:640px){
.cg-report{padding:${S.s4};border-radius:${R.lg}}
.cg-sec{padding-top:${S.s4}}
}
@media (max-width:640px){
.cg-report{font-size:15px}
.cg-contents ol{columns:1}
.cg-timeline li{grid-template-columns:minmax(0,1fr)}
.cg-facts{grid-template-columns:minmax(0,1fr)}
.cg-facts dd{margin-bottom:.4rem}
}
`;

/** Print: no application chrome, black on white, sensible page breaks, and the address of every link written out. */
const PRINT = `
@page{margin:16mm 14mm}
@media print{
.cg-skip-link,body header:not(.cg-head),body nav,body aside,body footer:not(.cg-foot),.cg-no-print,.fui-Toaster,[data-toaster-position]{display:none!important}
html,body{background:${PAPER.page}!important;color:${PAPER.ink}!important;height:auto!important;overflow:visible!important}
div:has(main#main-content){display:block!important;min-height:0!important;height:auto!important;overflow:visible!important}
main#main-content{padding:0!important;margin:0!important;overflow:visible!important}
.cg-report{${lightVariables};max-width:none;color:${PAPER.ink};font-size:11pt}
.cg-contents{display:none}
.cg-report .cg-print-only{display:block}
.cg-sec{padding:0 0 8pt;border:0;border-radius:0;background:transparent;margin:14pt 0}
.cg-sec>h2{break-after:avoid;padding-bottom:3pt;border-bottom:1.5pt solid ${PAPER.ink}}
.cg-sec h3,.cg-sec h4{break-after:avoid}
.cg-item,.cg-table tr,.cg-callout,.cg-strip-wrap,.cg-timeline li,.cg-facts{break-inside:avoid}
.cg-table thead{display:table-header-group}
.cg-strip-wrap{overflow:visible;border-color:${PAPER.frame}}
.cg-strip{min-width:0}
.cg-table-wrap{overflow:visible}
.cg-report a{color:${PAPER.ink};text-decoration:underline}
.cg-report a[href^="http"]:not(.cg-nourl)::after{content:" (" attr(href) ")";font-size:9pt;word-break:break-all;text-decoration:none}
.cg-leftout,.cg-callout,.cg-item{border-color:${PAPER.rule}}
}
`;

/** The whole stylesheet of the report document. */
export const REPORT_CSS = `${BASE}${PRINT}`.trim();

/** What the downloaded file adds around the document: the light theme variables and a plain page. */
export const STANDALONE_CSS = `${STANDALONE_VARIABLES}
html{background:var(--cgCanvas)}
body{margin:0;padding:${S.s6} ${S.s4};background:var(--cgCanvas);color:var(--cgText)}
@media print{body{padding:0}}
`;
