'use client';

import { Check, Link2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Copy the board's address, absolute, for pasting into a message.
 *
 * The absolute part is the point: the page renders a relative path, and a
 * relative path pasted into WhatsApp is not a link. It is resolved in the
 * browser, where the origin is known — a preview deployment and a custom
 * domain then both produce a URL that works, without a setting to keep in
 * step with either.
 */
export function CopyLink({
  path,
  /*
   * Named by the caller, because the job screen now carries two of these —
   * the name board's and the passenger's tracking link. Two elements sharing
   * one test id is a selector that silently matches the wrong button.
   */
  testId = 'copy-board-link',
}: {
  path: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = new URL(path, window.location.origin).toString();

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      // Long enough to be seen, short enough that the button is ready again
      // before somebody wants to copy a second one.
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused in some browsers outside a secure
      // context. Prompting is a poor substitute but it is one — the operator
      // still ends up with the link, which is the point.
      window.prompt('Copy the link', url);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void copy()}
      data-testid={testId}
    >
      {copied ? <Check aria-hidden /> : <Link2 aria-hidden />}
      {copied ? 'Copied' : 'Copy the link'}
    </Button>
  );
}
