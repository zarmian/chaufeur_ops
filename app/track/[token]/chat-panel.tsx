'use client';

import { SendHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { MESSAGE_MAX } from '@/lib/tracking-chat';
import type { ChatMessage } from '@/lib/tracking-chat-store';

/**
 * The passenger's end of the thread.
 *
 * Deliberately plain. This is opened one-handed, outdoors, by somebody who is
 * looking for a car rather than at a phone — so it is a list and a box, with
 * no read receipts, no typing indicator and nothing that implies the driver is
 * sitting waiting for a message. They are driving.
 *
 * The thread itself is rendered by the server and arrives with the page, which
 * already refreshes itself every twenty seconds to keep the ETA current — so a
 * driver's reply appears without this component polling for anything. All it
 * owns is the box, the send, and what to say when a send does not work.
 */
export function ChatPanel({
  token,
  messages,
  driverName,
  closed,
}: {
  token: string;
  messages: ChatMessage[];
  driverName: string | null;
  /**
   * Why the box is shut, when it is.
   *
   * The thread is still rendered — a passenger who asked something on the way
   * should not lose the answer the moment they are set down — but there is
   * nothing to type into and the reason is said rather than left to be
   * guessed at.
   */
  closed?: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Newest message in view without moving the page under somebody who is
  // reading further up.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (body === '' || sending) return;

    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/track/${encodeURIComponent(token)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        },
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        setError(payload?.message ?? 'That did not send. Try again.');
        return;
      }

      const sent = (await response.json()) as { delivered: boolean };

      /*
       * Cleared only once it is actually stored.
       *
       * A box emptied optimistically and then refused is a passenger who has
       * lost what they wrote while standing in the rain, and they will not
       * type it again.
       */
      setDraft('');
      if (!sent.delivered) {
        setError(
          'Saved, but we could not reach your driver’s phone. The office can pass it on.',
        );
      }
      router.refresh();
    } catch {
      setError('That did not send. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="rounded-lg border p-5" data-testid="tracking-chat">
      <h2 className="text-muted-foreground text-xs tracking-wide uppercase">
        {driverName ? `Message ${driverName}` : 'Message your driver'}
      </h2>

      {messages.length > 0 ? (
        <ol className="mt-3 space-y-2">
          {messages.map((message) => (
            <li
              key={message.id}
              className={
                message.author === 'PASSENGER' ? 'text-right' : 'text-left'
              }
            >
              <span
                className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-left text-sm ${
                  message.author === 'PASSENGER'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted'
                }`}
              >
                {message.body}
              </span>
              {/*
                Only ever said about the passenger's own messages, and only
                when it failed. A driver's reply is on the page by definition,
                and a tick beside every sent message would train somebody to
                read its absence as a fault rather than as an answer pending.
              */}
              {message.author === 'PASSENGER' && message.deliveredAt === null ? (
                <span className="text-muted-foreground mt-0.5 block text-xs">
                  Not delivered
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground mt-2 text-sm">
          Tell your driver where you are, or anything they should know.
        </p>
      )}

      <div ref={endRef} />

      {closed ? (
        <p className="text-muted-foreground mt-3 text-sm" data-testid="chat-closed">
          {closed}
        </p>
      ) : (
      <form onSubmit={send} className="mt-3 flex items-end gap-2">
        <label className="sr-only" htmlFor="chat-body">
          Message your driver
        </label>
        <textarea
          id="chat-body"
          name="body"
          rows={2}
          value={draft}
          maxLength={MESSAGE_MAX}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="I’m by the blue doors"
          className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-[2.75rem] w-full flex-1 resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          // Enter sends; Shift+Enter is a new line. The same contract as every
          // other message box somebody has used on a phone.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(event);
            }
          }}
        />
        <button
          type="submit"
          disabled={sending || draft.trim() === ''}
          className="bg-primary text-primary-foreground inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-50"
        >
          <SendHorizontal aria-hidden className="size-4" />
          <span className="sr-only sm:not-sr-only">Send</span>
        </button>
      </form>
      )}

      {error ? (
        <p
          className="text-destructive mt-2 text-sm"
          role="status"
          data-testid="chat-error"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
