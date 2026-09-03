'use client';

import { Loader2, MapPin } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  extractPostcode,
  newSessionToken,
  preferredAddressText,
  worthAsking,
  type PlaceSuggestion,
} from '@/lib/places/types';
import { cn } from '@/lib/utils';

/**
 * An address field that suggests as you type.
 *
 * Deliberately uncontrolled. The booking form learned this the hard way: a
 * controlled input re-renders the form on every keystroke, and a render
 * landing inside the submit action's transition restarts it — the operator
 * presses Book, nothing happens, and there is no error to explain it. So the
 * text lives in the DOM, and choosing a suggestion writes to it through the
 * native setter rather than through React.
 *
 * The postcode and coordinates ride along in hidden inputs. They are what
 * makes the choice worth anything: the postcode prices the job, and a
 * free-text address does not.
 *
 * Typing over a chosen suggestion clears them, because an address that says
 * "Heathrow T5" while carrying the coordinates of the Dorchester is worse
 * than one carrying nothing.
 */

const DEBOUNCE_MS = 250;

export interface AddressValue {
  text: string;
  postcode?: string | null;
  /** A string when it came off a form, a number when it came off a lookup. */
  lat?: number | string | null;
  lng?: number | string | null;
  locationId?: string | null;
}

export function AddressField({
  name,
  defaultValue,
  placeholder,
  required,
  autoFocus,
  invalid,
  describedBy,
  onChosen,
  clientId,
  /**
   * Whether to offer suggestions at all.
   *
   * Off, this is a plain text box: no lookup, no dropdown, nothing to choose
   * and nothing to overwrite what was typed. That is the right shape until a
   * provider that can find named places is connected — the fallback provider
   * only knows postcodes, so its whole contribution to a chauffeur operator's
   * pickup field was a list of postcodes and a way to lose the address the
   * operator had already typed.
   *
   * The postcode and coordinates carried on an existing job are untouched
   * while the field is left alone, and cleared the moment it is edited, which
   * is the same rule as before.
   */
  suggest = true,
}: {
  /** The text field's name. Hidden fields are `${name}Postcode` and so on. */
  name: string;
  defaultValue?: AddressValue;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** Told when a suggestion resolves, so a caller can re-quote. */
  onChosen?: (value: AddressValue) => void;
  /**
   * The client on the booking — spec 6.4.6.
   *
   * Their favourite locations are offered ahead of the globally popular ones.
   * A corporate account whose people always go to the same office should not
   * scroll past Heathrow to find it, and that office will never out-rank
   * Heathrow on a count taken across the whole business.
   */
  clientId?: string | null;
  suggest?: boolean;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * What the chosen suggestion resolved to.
   *
   * Held in state and rendered as controlled hidden inputs rather than
   * written through a ref, because `<input type="hidden">` has no dirty-value
   * flag: its `value` *is* the content attribute, so React's `defaultValue`
   * reconciliation overwrites whatever a ref wrote on the very next render.
   * The postcode disappeared silently, which is the worst way for it to go.
   *
   * The visible text field stays uncontrolled — that one has a real dirty
   * flag, and keeping it out of React is what stops a keystroke re-rendering
   * the booking form mid-submit.
   */
  const [resolved, setResolved] = useState<AddressValue | null>(
    defaultValue?.postcode || defaultValue?.lat || defaultValue?.lng
      ? defaultValue
      : null,
  );

  /**
   * The postcode read out of what was typed, when there is nothing to ask.
   *
   * With suggestions off nothing resolves an address, and the postcode is what
   * prices a job by zone — so a field that took plain text and threw the
   * postcode away would quietly cost money on every booking. An operator
   * pasting "10 Downing Street, London SW1A 2AA" has already supplied it;
   * this reads it back out.
   *
   * Only the postcode. Coordinates cannot be guessed from text, and inventing
   * them is how an address ends up describing somewhere it is not.
   */
  const [typedPostcode, setTypedPostcode] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);

  /**
   * One Google session per address, not per keystroke.
   *
   * Google bills a session, so the token is held across the typing and thrown
   * away when a suggestion is chosen. Without it the same search costs eight
   * times as much.
   */
  const session = useRef(newSessionToken());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);

  /**
   * Set the moment the form is submitted.
   *
   * Everything after this point stops touching state: a `setState` landing
   * inside the submit transition is what makes a form sit there having
   * apparently done nothing.
   */
  const submitted = useRef(false);

  /**
   * True while a suggestion is being applied.
   *
   * Writing to the input dispatches a real `input` event — it has to, or
   * React's value tracker goes stale — and that event reaches `onChange`,
   * which would clear the postcode this is in the middle of setting and
   * schedule a fresh lookup for the address just chosen.
   */
  const choosing = useRef(false);

  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;

    const stop = () => {
      submitted.current = true;
      if (timer.current) clearTimeout(timer.current);
      controller.current?.abort();
    };

    form.addEventListener('submit', stop);
    return () => form.removeEventListener('submit', stop);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      controller.current?.abort();
    },
    [],
  );

  function clearResolved() {
    // Typed over: whatever was resolved no longer describes what is in the
    // box, and stale coordinates are worse than none. Guarded so an ordinary
    // keystroke does not re-render for nothing.
    setResolved((current) => (current === null ? current : null));
  }

  function scanForPostcode(typed: string) {
    const found = extractPostcode(typed);
    // Guarded so an ordinary keystroke does not re-render for nothing.
    setTypedPostcode((current) => (current === found ? current : found));
  }

  function search(query: string) {
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();

    if (!worthAsking(query)) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    timer.current = setTimeout(async () => {
      if (submitted.current) return;

      const abort = new AbortController();
      controller.current = abort;
      setBusy(true);

      try {
        const response = await fetch(
          `/api/places/suggest?q=${encodeURIComponent(query)}&session=${encodeURIComponent(
            session.current,
          )}${clientId ? `&clientId=${encodeURIComponent(clientId)}` : ''}`,
          { signal: abort.signal },
        );
        if (!response.ok) throw new Error('lookup failed');

        const json = (await response.json()) as {
          suggestions: PlaceSuggestion[];
        };
        if (submitted.current || abort.signal.aborted) return;

        setSuggestions(json.suggestions);
        setActive(-1);
        setOpen(json.suggestions.length > 0);
      } catch {
        // A lookup that fails leaves the field a plain text box, which is
        // what it was before this feature existed. Nothing is blocked.
        if (!submitted.current) {
          setSuggestions([]);
          setOpen(false);
        }
      } finally {
        if (!submitted.current) setBusy(false);
      }
    }, DEBOUNCE_MS);
  }

  async function choose(suggestion: PlaceSuggestion) {
    setOpen(false);
    setSuggestions([]);
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();

    /*
     * What the operator actually typed, captured before anything overwrites
     * it. The optimistic write below replaces the box with the suggestion's
     * headline, so by the time the detail lookup returns the original is gone
     * from the DOM and there is nothing left to compare the label against.
     */
    const typedBefore = inputRef.current?.value.trim() ?? '';

    choosing.current = true;
    // Optimistic: show what was picked while the detail lookup runs, but never
    // less than was typed — the same rule the resolved value is held to.
    setInputValue(
      inputRef.current,
      preferredAddressText(typedBefore, suggestion.primary),
    );

    try {
      const response = await fetch('/api/places/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: suggestion.id, session: session.current }),
      });
      if (!response.ok) return;

      const detail = (await response.json()) as {
        label: string;
        address: string;
        postcode: string | null;
        lat: number | null;
        lng: number | null;
        locationId: string | null;
      };

      /*
       * The postcode and coordinates always ride along — they are what makes
       * choosing a suggestion worth anything, and they are what prices the
       * job. The *text* is the operator's unless the lookup genuinely knows
       * more; see `preferredAddressText`. Overwriting it unconditionally is
       * what turned a pasted street address into a bare postcode.
       */
      const value: AddressValue = {
        text: preferredAddressText(typedBefore, detail.label || detail.address),
        postcode: detail.postcode,
        lat: detail.lat,
        lng: detail.lng,
        locationId: detail.locationId,
      };

      setInputValue(inputRef.current, value.text);
      setResolved(value);
      onChosen?.(value);
    } catch {
      // Keep what was typed. A failed resolve is a missing postcode, not a
      // lost booking.
    } finally {
      choosing.current = false;
      // A new session for the next address in this form.
      session.current = newSessionToken();
    }
  }

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={name}
        name={name}
        type="text"
        autoComplete="off"
        /*
         * Only a combobox when there is a list. Announcing one to a screen
         * reader and then never populating it is worse than a plain text
         * field, which is exactly what this is with suggestions off.
         */
        role={suggest ? 'combobox' : undefined}
        aria-expanded={suggest ? open : undefined}
        aria-controls={suggest ? listId : undefined}
        aria-autocomplete={suggest ? 'list' : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        defaultValue={defaultValue?.text ?? ''}
        onChange={(event) => {
          if (choosing.current) return;
          clearResolved();
          if (suggest) search(event.target.value);
          else scanForPostcode(event.target.value);
        }}
        onKeyDown={(event) => {
          if (!open || suggestions.length === 0) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((current) => (current + 1) % suggestions.length);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((current) =>
              current <= 0 ? suggestions.length - 1 : current - 1,
            );
          } else if (event.key === 'Enter' && active >= 0) {
            // Only when something is highlighted, so Enter still submits the
            // form when the list is merely open.
            event.preventDefault();
            void choose(suggestions[active]!);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
        // A blur that closes immediately beats the click on a suggestion, so
        // the close is deferred by one turn of the event loop.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />

      <input
        type="hidden"
        name={`${name}Postcode`}
        // A resolved address knows its own postcode; a typed one only has
        // whatever is in the text. `resolved` wins because it came from a
        // provider, and it is null the moment the box is edited.
        value={resolved?.postcode ?? typedPostcode ?? ''}
        readOnly
      />
      <input
        type="hidden"
        name={`${name}Lat`}
        value={text(resolved?.lat)}
        readOnly
      />
      <input
        type="hidden"
        name={`${name}Lng`}
        value={text(resolved?.lng)}
        readOnly
      />
      <input
        type="hidden"
        name={`${name}LocationId`}
        value={resolved?.locationId ?? ''}
        readOnly
      />

      {suggest && busy ? (
        <Loader2
          className="text-muted-foreground absolute top-2.5 right-2 size-4 animate-spin"
          aria-hidden
        />
      ) : null}

      {suggest && open && suggestions.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          data-testid={`${name}-suggestions`}
          className="bg-popover absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border p-1 shadow-md"
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                // `onMouseDown` rather than `onClick`: the input's blur fires
                // first otherwise and the list is gone before the click lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  void choose(suggestion);
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm',
                  index === active
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent',
                )}
              >
                <MapPin
                  className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {suggestion.primary}
                  </span>
                  {suggestion.secondary ? (
                    <span className="text-muted-foreground block truncate text-xs">
                      {suggestion.secondary}
                    </span>
                  ) : null}
                </span>
                {suggestion.source === 'saved' ? (
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                    saved
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A coordinate as a form field carries it. */
function text(value: number | string | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Write to an uncontrolled input so React and the DOM agree.
 *
 * Assigning `.value` directly leaves React's internal tracker holding the old
 * string, and the next `onChange` is then dropped as a no-op. Going through
 * the prototype setter and dispatching a real `input` event is the supported
 * way round it.
 */
function setInputValue(input: HTMLInputElement | null, value: string): void {
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
