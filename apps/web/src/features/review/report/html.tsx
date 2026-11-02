import { Fragment } from 'react';
import { REPORT_CSS, STANDALONE_CSS } from './css';
import { ReportDocument, type ReportDocumentProps } from './ReportDocument';

/**
 * What the downloaded file is allowed to do: nothing but show itself. No scripts, no network, no frames, no fonts, no
 * forms, no `<base>`; only its own inline stylesheet and inline data images. A browser that opens the file enforces this
 * even if a script were somehow written into it.
 */
export const STANDALONE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * The report as one self-contained HTML file: the same document component the app shows, rendered to static markup, with
 * its stylesheet inline. React escapes every string that came from a case; the only other strings in the file are
 * constants, and the title is escaped by React as well. There is no script element and no event handler anywhere.
 */
export async function buildReportHtml(props: ReportDocumentProps): Promise<string> {
  // Loaded when someone asks for the file, so the server renderer is not part of the page itself.
  const { renderToStaticMarkup } = await import('react-dom/server');
  const reference = props.report.header?.reference ?? 'Case';
  const title = renderToStaticMarkup(<Fragment>{`${reference}: guided review report`}</Fragment>);
  const body = renderToStaticMarkup(<ReportDocument {...props} />);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${STANDALONE_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="generator" content="CaseGuard AI">',
    `<title>${title}</title>`,
    `<style>${STANDALONE_CSS}\n${REPORT_CSS}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
    '',
  ].join('\n');
}

/** Saves text as a file through the browser, without a server: an object address that is released right after. */
export function downloadFile(content: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
