'use client';

import type { EvidenceLink } from '@caseguard/schemas';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { codecs, useUrlChoiceState } from '../../../lib/url-state';
import { linkKey, parseLinkKey } from '../model/links';
import { EvidenceDrawer } from './EvidenceDrawer';

export interface OpenEvidence {
  /** Every link of the recommendation or decision point, so the rest can be read after the one that was asked for. */
  links: readonly EvidenceLink[];
  /** The link the person asked about; it is shown first. */
  focus: EvidenceLink;
  /** What the evidence is for, in words: the title of the recommendation or decision point. */
  subject: string;
}

export interface EvidenceApi {
  open: (request: OpenEvidence) => void;
  close: () => void;
}

const EvidenceContext = createContext<EvidenceApi | null>(null);

/** Opens and closes the evidence drawer from anywhere in the review. */
export function useEvidence(): EvidenceApi {
  const api = useContext(EvidenceContext);
  if (!api) throw new Error('useEvidence must be used inside <EvidenceProvider>');
  return api;
}

const FOCUS_CODEC = codecs.optionalString();

interface Group {
  links: readonly EvidenceLink[];
  subject: string;
}

/**
 * Owns the one evidence drawer of a page. What it shows is `?evidence=<type>:<id>` in the address, so the drawer
 * survives a reload, can be shared, and is still open when the person comes back from "Show in timeline" with Back.
 * The choice is shown at once and written to the address (`useUrlChoiceState`); the address is written in place, so
 * opening it never adds a step to the history.
 *
 * Focus goes back to the control that opened the drawer when it closes, and to the main region when that control is
 * gone, so a keyboard user is never left on the page body.
 */
export function EvidenceProvider({ caseId, children }: { caseId: string; children: ReactNode }) {
  const [focusKey, setFocusKey] = useUrlChoiceState('evidence', FOCUS_CODEC);
  const [group, setGroup] = useState<Group | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const open = useCallback(
    (request: OpenEvidence) => {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      setGroup({ links: request.links, subject: request.subject });
      setFocusKey(linkKey(request.focus));
    },
    [setFocusKey],
  );

  const close = useCallback(() => {
    setFocusKey(null);
    setGroup(null);
    const target = opener.current;
    opener.current = null;
    // After the drawer has unmounted, so its own focus handling cannot take the focus back.
    window.setTimeout(() => {
      if (target?.isConnected) target.focus();
      else document.getElementById('main-content')?.focus();
    }, 0);
  }, [setFocusKey]);

  const api = useMemo(() => ({ open, close }), [open, close]);

  // A link from the address, or one the page opened: the page's own group when it holds the link, else the link alone.
  const focus = parseLinkKey(focusKey);
  const links = focus
    ? group && group.links.some((link) => linkKey(link) === focusKey)
      ? group.links
      : [focus]
    : [];

  return (
    <EvidenceContext.Provider value={api}>
      {children}
      <EvidenceDrawer
        caseId={caseId}
        open={focus !== null}
        links={links}
        focusKey={focusKey}
        subject={group?.subject ?? null}
        onClose={close}
      />
    </EvidenceContext.Provider>
  );
}
