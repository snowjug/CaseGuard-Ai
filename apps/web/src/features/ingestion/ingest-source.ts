import type { IngestRequest } from '@caseguard/schemas';

/** In the order the segmented control shows them. The URL parameter `source` carries one of these values. */
export const SOURCE_CHOICES = ['paste', 'file', 'sample', 'bundle'] as const;
export type SourceChoice = (typeof SOURCE_CHOICES)[number];

/** The short segment texts. */
export const SOURCE_CHOICE_LABELS: Record<SourceChoice, string> = {
  paste: 'Paste',
  file: 'Upload',
  sample: 'Sample',
  bundle: 'JSON',
};

/** The limits the API publishes in its contract (`IngestRequestSchema`): longer input is refused with a 422. */
export const PASTE_MAX_CHARS = 200_000;
export const TITLE_MIN = 5;
export const TITLE_MAX = 200;
export const WORKLOAD_MAX = 80;

/** Extensions the API accepts for uploads. Its own check (by content, not by name) is the authority. */
export const ACCEPTED_EXTENSIONS = ['.json', '.txt', '.log', '.md', '.csv'] as const;
/** Default upload limit of the API (`UPLOAD_MAX_BYTES`); the configured value may differ, so this is only a hint. */
export const DEFAULT_UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024;

export interface SourceDraft {
  choice: SourceChoice;
  sampleId: string | null;
  pasteText: string;
  title: string;
  workload: string;
  file: File | null;
  bundleText: string;
}

export const EMPTY_DRAFT: SourceDraft = {
  choice: 'paste',
  sampleId: null,
  pasteText: '',
  title: '',
  workload: '',
  file: null,
  bundleText: '',
};

export interface DraftProblem {
  field: 'sample' | 'pasteText' | 'title' | 'workload' | 'file' | 'bundleText';
  message: string;
}

/** The first problem with a JSON text, or null when it parses. The message includes the position the engine reports. */
export function jsonProblem(text: string): string | null {
  if (text.trim() === '') return null;
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'The text is not valid JSON.';
  }
}

/** Lower-case extension including the dot, or an empty string. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase();
}

/** Problems that can be found before asking the API, so the person gets an instant, specific hint. */
export function draftProblems(draft: SourceDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  switch (draft.choice) {
    case 'sample':
      if (!draft.sampleId) problems.push({ field: 'sample', message: 'Choose a sample.' });
      break;
    case 'paste': {
      if (draft.pasteText.trim() === '')
        problems.push({ field: 'pasteText', message: 'Paste the case text.' });
      else if (draft.pasteText.length > PASTE_MAX_CHARS)
        problems.push({
          field: 'pasteText',
          message: `Pasted text is limited to ${PASTE_MAX_CHARS.toLocaleString('en-US')} characters.`,
        });
      const title = draft.title.trim();
      if (title !== '' && (title.length < TITLE_MIN || title.length > TITLE_MAX))
        problems.push({
          field: 'title',
          message: `A title needs ${TITLE_MIN} to ${TITLE_MAX} characters, or leave it empty.`,
        });
      if (draft.workload.trim().length > WORKLOAD_MAX)
        problems.push({
          field: 'workload',
          message: `A workload key is limited to ${WORKLOAD_MAX} characters.`,
        });
      break;
    }
    case 'file':
      if (!draft.file) problems.push({ field: 'file', message: 'Choose a file to upload.' });
      else if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(draft.file.name)))
        problems.push({
          field: 'file',
          message: `Only ${ACCEPTED_EXTENSIONS.join(', ')} files are accepted.`,
        });
      else if (fileNeedsWorkload(draft.file)) {
        const workload = draft.workload.trim();
        if (workload === '')
          problems.push({ field: 'workload', message: 'Choose the workload of this file.' });
        else if (workload.length > WORKLOAD_MAX)
          problems.push({
            field: 'workload',
            message: `A workload key is limited to ${WORKLOAD_MAX} characters.`,
          });
      }
      break;
    case 'bundle': {
      if (draft.bundleText.trim() === '')
        problems.push({ field: 'bundleText', message: 'Paste or load a JSON case bundle.' });
      else {
        const syntax = jsonProblem(draft.bundleText);
        if (syntax) problems.push({ field: 'bundleText', message: `Not valid JSON: ${syntax}` });
      }
      break;
    }
  }
  return problems;
}

/** A request the preview and create routes understand: a JSON source, or a multipart upload. */
export type SourceRequest =
  { type: 'json'; source: IngestRequest } | { type: 'upload'; file: File; workload: string | null };

/**
 * Whether the person has to choose a workload for this file. A JSON bundle states its own, so a different
 * choice would only contradict it; a CSV or text file cannot state one, and CaseGuard does not guess.
 */
export function fileNeedsWorkload(file: File | null): boolean {
  return file !== null && extensionOf(file.name) !== '.json';
}

/** The request for a draft, or null while the draft has problems. */
export function buildSourceRequest(draft: SourceDraft): SourceRequest | null {
  if (draftProblems(draft).length > 0) return null;
  switch (draft.choice) {
    case 'sample':
      return draft.sampleId
        ? { type: 'json', source: { type: 'sample', sampleId: draft.sampleId } }
        : null;
    case 'paste': {
      const title = draft.title.trim();
      const workload = draft.workload.trim();
      return {
        type: 'json',
        source: {
          type: 'paste',
          text: draft.pasteText,
          ...(title ? { title } : {}),
          ...(workload ? { workload } : {}),
        },
      };
    }
    case 'bundle':
      return {
        type: 'json',
        source: { type: 'bundle', bundle: JSON.parse(draft.bundleText) as unknown },
      };
    case 'file': {
      if (!draft.file) return null;
      const workload = fileNeedsWorkload(draft.file) ? draft.workload.trim() : '';
      return { type: 'upload', file: draft.file, workload: workload || null };
    }
  }
}

/** Multipart body of an upload (the API reads the field named `file` and the optional text field `workload`). */
export function uploadForm(file: File, workload: string | null = null): FormData {
  const form = new FormData();
  // Sent before the file, so that a server reading the form in order has it first.
  if (workload) form.append('workload', workload);
  form.append('file', file, file.name);
  return form;
}

/** `1.5 MB` style size for the upload hint. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
