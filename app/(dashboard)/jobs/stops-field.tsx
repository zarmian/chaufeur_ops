'use client';

import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface StopValue {
  address: string;
  waitMinutes: string;
  charge: string;
  note: string;
}

const BLANK_STOP: StopValue = { address: '', waitMinutes: '', charge: '', note: '' };

/**
 * Ordered stops between pickup and dropoff.
 *
 * Posts as parallel arrays — `stopAddress[]`, `stopWait[]`, `stopCharge[]` —
 * which is how a repeating fieldset submits without JavaScript rewriting the
 * names on every add and remove. The server zips them back together in order.
 *
 * A stop carries its own charge because a second drop is chargeable work, and
 * the alternative is that it disappears into the base fare where nobody can
 * see what it earned.
 */
export function StopsField({
  initial = [],
  locations,
}: {
  initial?: StopValue[];
  locations: string[];
}) {
  const [stops, setStops] = useState<StopValue[]>(initial);

  const update = (index: number, patch: Partial<StopValue>) =>
    setStops((current) =>
      current.map((stop, i) => (i === index ? { ...stop, ...patch } : stop)),
    );

  return (
    <div className="space-y-3" data-testid="stops-field">
      {stops.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No stops. Add one for each place the car has to wait or drop
          somebody.
        </p>
      ) : null}

      {stops.map((stop, index) => (
        <div
          key={index}
          className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_7rem_7rem_auto]"
        >
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Stop {index + 1}
            </label>
            <Input
              name="stopAddress"
              value={stop.address}
              list="saved-locations"
              placeholder="Where the car stops"
              required
              onChange={(event) => update(index, { address: event.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Wait (min)
            </label>
            <Input
              name="stopWait"
              inputMode="numeric"
              value={stop.waitMinutes}
              onChange={(event) => update(index, { waitMinutes: event.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Charge</label>
            <Input
              name="stopCharge"
              inputMode="decimal"
              placeholder="15.00"
              value={stop.charge}
              onChange={(event) => update(index, { charge: event.target.value })}
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove stop ${index + 1}`}
              onClick={() => setStops((current) => current.filter((_, i) => i !== index))}
            >
              <X aria-hidden />
            </Button>
          </div>
          <input type="hidden" name="stopNote" value={stop.note} />
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setStops((current) => [...current, { ...BLANK_STOP }])}
      >
        <Plus aria-hidden />
        Add a stop
      </Button>

      <datalist id="saved-locations">
        {locations.map((location) => (
          <option key={location} value={location} />
        ))}
      </datalist>
    </div>
  );
}
