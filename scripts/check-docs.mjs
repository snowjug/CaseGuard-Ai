#!/usr/bin/env node
// Documentation checks: every relative link, image and heading anchor in the Markdown files resolves, every
// Mermaid diagram is closed and not empty, every workflow badge names a workflow that exists, and every
// screenshot a page shows is a file in the repository.
//
//   node scripts/check-docs.mjs [--root <dir>] [--quiet]
//   node scripts/check-docs.mjs --self-test
//
// Rules (each problem is printed as `file:line: [rule] message`; the exit code is 1 when there is any):
//   link-missing          a relative link points at a file or directory that does not exist (the match is
//                         case-sensitive, like GitHub, even on a case-insensitive disk)
//   anchor-missing        `file.md#anchor` or `#anchor` is not a heading (GitHub slug rules) or an HTML id of that file
//   image-missing         a relative image does not exist
//   screenshot-missing    the same, for an image under a `screenshots` directory
//   mermaid-empty         a ```mermaid fence has no content
//   mermaid-unterminated  a ```mermaid fence is never closed
//   fence-unterminated    any other code fence is never closed (it would swallow the rest of the page)
//   badge-workflow-missing a badge or link names `.github/workflows/<file>` and that file does not exist
//
// Links inside code spans, code fences and HTML comments are ignored. External links (http, https, mailto, ...) are
// not fetched: this check needs no network. No dependencies; the exit code is 0 when nothing is wrong, 1 when a rule
// is broken and 2 for a usage error.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.data',
  'playwright-report',
  'test-results',
  'pgdata',
  '.turbo',
  '.pnpm-store',
]);
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
const WORKFLOW_REFERENCES = [
  /actions\/workflows\/([A-Za-z0-9._-]+\.ya?ml)/g,
  /github\/actions\/workflow\/status\/[^/\s)]+\/[^/\s)]+\/([A-Za-z0-9._-]+\.ya?ml)/g,
];

/** @typedef {{ file: string, line: number, rule: string, message: string }} Problem */

// ------------------------------------------------------------------ headings and anchors

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** GitHub's heading slug: the rendered text, lower case, only letters, marks, digits, `_`, `-` and spaces, spaces to `-`. */
export function slugify(raw) {
  const text = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .replace(/\*+/g, '')
    .replace(/~~/g, '')
    .replace(/(^|[\s(])_(\S(?:.*?\S)?)_(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity);
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Blanks out HTML comments but keeps every newline, so line numbers stay right. */
function withoutComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;

/**
 * Walks the lines of a page once and reports what is outside code fences. Fences are matched like CommonMark does
 * (the closing fence uses the same character and is at least as long as the opening one).
 *
 * @param {string} markdown
 */
export function scanMarkdown(markdown) {
  const lines = withoutComments(markdown.replace(/\r\n/g, '\n')).split('\n');
  /** @type {{ line: number, text: string }[]} */
  const prose = [];
  /** @type {{ line: number, info: string, closed: boolean, content: number }[]} */
  const fences = [];
  let open = null;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (open !== null) {
      const closing = new RegExp(
        `^\\s*${open.marker[0] === '`' ? '`' : '~'}{${open.marker.length},}\\s*$`,
      );
      if (closing.test(text)) {
        open.fence.closed = true;
        open = null;
      } else if (text.trim() !== '') {
        open.fence.content += 1;
      }
      continue;
    }
    const start = FENCE_OPEN.exec(text);
    if (start !== null) {
      const fence = {
        line: index + 1,
        info: (start[2] ?? '').toLowerCase(),
        closed: false,
        content: 0,
      };
      fences.push(fence);
      open = { marker: start[1], fence };
      continue;
    }
    prose.push({ line: index + 1, text });
  }
  return { prose, fences };
}

/** The anchors a page offers: its headings (with GitHub's `-1`, `-2` suffixes for repeats) and explicit HTML ids. */
export function collectAnchors(markdown) {
  const { prose } = scanMarkdown(markdown);
  const anchors = new Set();
  const seen = new Map();
  const add = (heading) => {
    const base = slugify(heading.trim());
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  };
  for (let index = 0; index < prose.length; index += 1) {
    const { text } = prose[index];
    const atx = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(text);
    if (atx !== null) {
      add(atx[1]);
      continue;
    }
    const next = prose[index + 1];
    if (
      next !== undefined &&
      next.line === prose[index].line + 1 &&
      /^ {0,3}(=+|-{2,})[ \t]*$/.test(next.text) &&
      /^ {0,3}[^\s#>|*+\-=\d`~]/.test(text)
    ) {
      add(text);
      index += 1;
    }
  }
  for (const { text } of prose) {
    for (const match of text.matchAll(/<[a-z][^>]*\b(?:id|name)\s*=\s*"([^"]+)"/gi))
      anchors.add(match[1]);
  }
  return anchors;
}

// ------------------------------------------------------------------ links

/** Index of the `[` that matches the `]` at `close`, or -1. */
function matchingOpenBracket(line, close) {
  let depth = 0;
  for (let index = close - 1; index >= 0; index -= 1) {
    if (line[index] === ']' && line[index - 1] !== '\\') depth += 1;
    else if (line[index] === '[' && line[index - 1] !== '\\') {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

/** Reads a link destination that starts at `start` (just after the opening parenthesis). */
function readDestination(line, start) {
  let index = start;
  while (line[index] === ' ') index += 1;
  let target;
  if (line[index] === '<') {
    const end = line.indexOf('>', index + 1);
    if (end === -1) return { target: null, end: line.length };
    target = line.slice(index + 1, end);
    index = end + 1;
  } else {
    let depth = 0;
    const begin = index;
    while (index < line.length) {
      const char = line[index];
      if (char === '\\') index += 2;
      else if (char === '(') {
        depth += 1;
        index += 1;
      } else if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
        index += 1;
      } else if (/\s/.test(char)) break;
      else index += 1;
    }
    target = line.slice(begin, index);
  }
  // An optional title ("..." or '...' or (...)) may follow; skip to the closing parenthesis.
  const close = line.indexOf(')', index);
  return { target, end: close === -1 ? line.length : close + 1 };
}

/** Inline links and images of one line of prose (code spans are blanked out first). */
function inlineLinks(rawLine) {
  const line = rawLine.replace(/(`+)(.*?)\1/g, (span) => ' '.repeat(span.length));
  const found = [];
  let index = 0;
  while ((index = line.indexOf('](', index)) !== -1) {
    const open = matchingOpenBracket(line, index);
    const { target, end } = readDestination(line, index + 2);
    if (open !== -1 && target !== null && target !== '') {
      found.push({ target, image: open > 0 && line[open - 1] === '!' });
    }
    index = Math.max(end, index + 2);
  }
  const definition = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/.exec(line);
  if (definition !== null)
    found.push({ target: definition[1].replace(/^<|>$/g, ''), image: false });
  for (const match of line.matchAll(
    /<(img|a|source|video)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
  )) {
    found.push({ target: match[2] ?? match[3] ?? '', image: match[1].toLowerCase() !== 'a' });
  }
  return found.filter((link) => link.target !== '');
}

// ------------------------------------------------------------------ file system

/** Walks `root` for Markdown files, skipping dependencies and build output. Sorted, with forward slashes. */
export function listMarkdownFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.next')) continue;
        walk(join(directory, entry.name));
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        found.push(join(directory, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

function createFileSystem() {
  const listings = new Map();
  const names = (directory) => {
    let list = listings.get(directory);
    if (list === undefined) {
      try {
        list = new Set(readdirSync(directory));
      } catch {
        list = new Set();
      }
      listings.set(directory, list);
    }
    return list;
  };
  return {
    /** True when the path exists and every segment below `root` has exactly that letter case (GitHub is case-sensitive). */
    existsExact(root, target) {
      if (!existsSync(target)) return false;
      const parts = relative(root, target)
        .split(sep)
        .filter((part) => part !== '' && part !== '.');
      if (parts[0] === '..') return true;
      let current = root;
      for (const part of parts) {
        if (part === '..') return true;
        if (!names(current).has(part)) return false;
        current = join(current, part);
      }
      return true;
    },
  };
}

function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// ------------------------------------------------------------------ the check

/**
 * Checks every Markdown file under `root`.
 *
 * @param {{ root?: string }} [options]
 * @returns {{ files: number, problems: Problem[] }}
 */
export function checkDocs({ root = DEFAULT_ROOT } = {}) {
  const base = resolve(root);
  const files = listMarkdownFiles(base);
  const fileSystem = createFileSystem();
  const anchorCache = new Map();
  const anchorsOf = (file) => {
    let anchors = anchorCache.get(file);
    if (anchors === undefined) {
      anchors = collectAnchors(readFileSync(file, 'utf8'));
      anchorCache.set(file, anchors);
    }
    return anchors;
  };
  const workflowsDirectory = join(base, '.github', 'workflows');
  /** @type {Problem[]} */
  const problems = [];

  for (const file of files) {
    const shown = relative(base, file).split(sep).join('/');
    const add = (line, rule, message) => problems.push({ file: shown, line, rule, message });
    const text = readFileSync(file, 'utf8');
    const { prose, fences } = scanMarkdown(text);

    for (const fence of fences) {
      if (fence.info === 'mermaid') {
        if (!fence.closed)
          add(fence.line, 'mermaid-unterminated', 'the Mermaid fence is never closed');
        else if (fence.content === 0)
          add(fence.line, 'mermaid-empty', 'the Mermaid fence is empty');
      } else if (!fence.closed) {
        add(fence.line, 'fence-unterminated', 'the code fence is never closed');
      }
    }

    for (const { line, text: content } of prose) {
      for (const pattern of WORKFLOW_REFERENCES) {
        for (const match of content.matchAll(pattern)) {
          if (!existsSync(join(workflowsDirectory, match[1]))) {
            add(line, 'badge-workflow-missing', `.github/workflows/${match[1]} does not exist`);
          }
        }
      }
      for (const { target, image } of inlineLinks(content)) {
        if (EXTERNAL.test(target) || target.startsWith('//')) continue;
        const hash = target.indexOf('#');
        const pathPart = decode((hash === -1 ? target : target.slice(0, hash)).split('?')[0]);
        const anchor = hash === -1 ? null : decode(target.slice(hash + 1));
        const destination =
          pathPart === ''
            ? file
            : pathPart.startsWith('/')
              ? join(base, pathPart)
              : resolve(dirname(file), pathPart);
        if (pathPart !== '' && !fileSystem.existsExact(base, destination)) {
          const screenshot = image && /(^|[\\/])screenshots([\\/]|$)/i.test(pathPart);
          const rule = screenshot ? 'screenshot-missing' : image ? 'image-missing' : 'link-missing';
          add(
            line,
            rule,
            `${screenshot ? 'screenshot' : image ? 'image' : 'target'} not found: ${target}`,
          );
          continue;
        }
        if (
          anchor !== null &&
          anchor !== '' &&
          /\.md$/i.test(destination) &&
          existsSync(destination)
        ) {
          if (!anchorsOf(destination).has(anchor)) {
            add(
              line,
              'anchor-missing',
              `no heading or id "${anchor}" in ${relative(base, destination).split(sep).join('/')}`,
            );
          }
        }
      }
    }
  }
  problems.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
  return { files: files.length, problems };
}

// ------------------------------------------------------------------ self-test

function selfTest() {
  const results = [];
  const check = (name, fn) => {
    let ok = false;
    try {
      ok = fn() === true;
    } catch (error) {
      console.error(`  error in "${name}": ${error.message}`);
    }
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  };
  const scratch = mkdtempSync(join(tmpdir(), 'cg-check-docs-'));
  const put = (path, content) => {
    const absolute = join(scratch, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };
  const run = () => checkDocs({ root: scratch });
  const rulesOf = (outcome) =>
    outcome.problems.map((problem) => `${problem.file}:${problem.line}:${problem.rule}`);

  try {
    check(
      'slugify follows GitHub (punctuation dropped, spaces become hyphens, code and links keep their text)',
      () =>
        slugify('8.2 Demo data') === '82-demo-data' &&
        slugify('`pnpm demo:seed` and [the guide](x.md)') === 'pnpm-demoseed-and-the-guide' &&
        slugify('Rate limits & "quotas" (per user)') === 'rate-limits--quotas-per-user' &&
        slugify('DB_AUTO_MIGRATE *and* _more_') === 'db_auto_migrate-and-more',
    );
    check(
      'repeated headings get -1, -2; setext headings and html ids count; fenced and commented headings do not',
      () => {
        const anchors = collectAnchors(
          [
            '# A',
            '## A',
            '## A',
            'Setext',
            '------',
            '<a id="by-hand"></a>',
            '```',
            '# fenced',
            '```',
            '<!-- # hidden -->',
          ].join('\n'),
        );
        return (
          ['a', 'a-1', 'a-2', 'setext', 'by-hand'].every((anchor) => anchors.has(anchor)) &&
          !anchors.has('fenced') &&
          !anchors.has('hidden')
        );
      },
    );

    put(
      'docs/a.md',
      [
        '# Alpha',
        '',
        '## Beta Gamma',
        '',
        '[ok](b.md)',
        '[ok anchor](b.md#target-heading)',
        '[same](#beta-gamma)',
        '[dir](../docs)',
        '[ext](https://example.com/x)',
        '[mail](mailto:a@b.c)',
        '[query](b.md?x=1#target-heading)',
        '[spaces](c%20d.md)',
        '[root](/docs/b.md)',
      ].join('\n'),
    );
    put('docs/b.md', '# Target heading\n');
    put('docs/c d.md', '# C\n');
    check(
      'valid links, anchors, directories, queries, %20, root-relative and external targets pass',
      () => {
        const outcome = run();
        return outcome.problems.length === 0 && outcome.files === 3;
      },
    );

    put(
      'docs/bad.md',
      [
        '[gone](missing.md)',
        '[bad anchor](b.md#nope)',
        '[bad same](#nope)',
        '![shot](assets/screenshots/x.png)',
        '![pic](assets/y.png)',
        '[case](B.md)',
      ].join('\n'),
    );
    check(
      'a missing file, missing anchors, a missing screenshot and image, and a wrong letter case are each reported',
      () => {
        const rules = rulesOf(run()).filter((entry) => entry.startsWith('docs/bad.md'));
        return (
          rules.join() ===
          [
            'docs/bad.md:1:link-missing',
            'docs/bad.md:2:anchor-missing',
            'docs/bad.md:3:anchor-missing',
            'docs/bad.md:4:screenshot-missing',
            'docs/bad.md:5:image-missing',
            'docs/bad.md:6:link-missing',
          ].join()
        );
      },
    );
    rmSync(join(scratch, 'docs', 'bad.md'));

    put(
      'docs/code.md',
      [
        '`[inline](gone.md)` and',
        '```md',
        '[fenced](gone.md)',
        '# not a heading',
        '```',
        '<!-- [commented](gone.md) -->',
        '<img src="b.md"> <a href="gone.md">x</a>',
        '[ref]: missing-ref.md',
      ].join('\n'),
    );
    check(
      'links in code spans, fences and comments are ignored; html src/href and reference definitions are checked',
      () => {
        const rules = rulesOf(run()).filter((entry) => entry.startsWith('docs/code.md'));
        return rules.join() === 'docs/code.md:7:link-missing,docs/code.md:8:link-missing';
      },
    );
    rmSync(join(scratch, 'docs', 'code.md'));

    put(
      'docs/diagrams.md',
      [
        '```mermaid',
        'flowchart LR',
        '  A --> B',
        '```',
        '',
        '```mermaid',
        '```',
        '',
        '```mermaid',
        '   ',
        '```',
        '',
        '~~~mermaid',
        'graph TD',
        '  A --> B',
      ].join('\n'),
    );
    check('a Mermaid fence that is empty or never closed is reported, a good one is not', () => {
      const rules = rulesOf(run()).filter((entry) => entry.startsWith('docs/diagrams.md'));
      return (
        rules.join() ===
        'docs/diagrams.md:6:mermaid-empty,docs/diagrams.md:9:mermaid-empty,docs/diagrams.md:13:mermaid-unterminated'
      );
    });
    rmSync(join(scratch, 'docs', 'diagrams.md'));

    put('docs/fence.md', ['```ts', 'const a = 1;'].join('\n'));
    check(
      'an unterminated ordinary code fence is reported',
      () => rulesOf(run()).join() === 'docs/fence.md:1:fence-unterminated',
    );
    rmSync(join(scratch, 'docs', 'fence.md'));

    put('.github/workflows/ci.yml', 'name: CI\n');
    put(
      'README.md',
      [
        '[![CI](https://github.com/o/r/actions/workflows/ci.yml/badge.svg)](https://github.com/o/r/actions/workflows/ci.yml)',
        '[![Gone](https://github.com/o/r/actions/workflows/gone.yml/badge.svg)](https://github.com/o/r/actions/workflows/gone.yml)',
        '![shield](https://img.shields.io/github/actions/workflow/status/o/r/also-gone.yaml)',
      ].join('\n'),
    );
    check('a badge must name a workflow file that exists', () => {
      const rules = rulesOf(run());
      return (
        rules.join() ===
        'README.md:2:badge-workflow-missing,README.md:2:badge-workflow-missing,README.md:3:badge-workflow-missing'
      );
    });
    rmSync(join(scratch, 'README.md'));

    put('node_modules/pkg/README.md', '[gone](nowhere.md)\n');
    check('dependency and build directories are not scanned', () => run().problems.length === 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const passed = results.filter(Boolean).length;
  console.log(`check-docs self-test: ${passed}/${results.length} passed`);
  return passed === results.length;
}

// ------------------------------------------------------------------ command line

function main(argv) {
  let root = DEFAULT_ROOT;
  let quiet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--self-test') return selfTest() ? 0 : 1;
    if (argument === '--quiet') quiet = true;
    else if (argument === '--root') {
      const value = argv[(index += 1)];
      if (value === undefined) {
        console.error('--root needs a directory');
        return 2;
      }
      root = resolve(value);
    } else if (argument !== '--') {
      console.error(
        `Unknown argument "${argument}". Usage: node scripts/check-docs.mjs [--root <dir>] [--quiet] | --self-test`,
      );
      return 2;
    }
  }
  if (!existsSync(root)) {
    console.error(`${root} does not exist`);
    return 2;
  }
  const { files, problems } = checkDocs({ root });
  for (const problem of problems)
    console.error(`${problem.file}:${problem.line}: [${problem.rule}] ${problem.message}`);
  if (problems.length > 0) {
    console.error(`check-docs: ${problems.length} problem(s) in ${files} Markdown file(s)`);
    return 1;
  }
  if (!quiet) console.log(`check-docs: ${files} Markdown file(s) checked, no problems`);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main(process.argv.slice(2));
}
