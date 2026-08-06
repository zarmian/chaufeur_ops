'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';

/**
 * "Repeats" on the booking form — spec 6.3.3.
 *
 * Collapsed until ticked, because the overwhelming majority of bookings are
 * one-offs and a form that shows six recurrence fields to everybody makes the
 * common case slower to serve.
 *
 * The end is a radio between a count and a date, not two optional boxes. Two
 * boxes means deciding which one wins when both are filled, and whichever way
 * that goes half the operators will be surprised by it.
 *
 * Its own component, and its own state, so ticking the box does not re-render
 * the booking form — a render landing inside the Server Action's transition
 * swallows the submit, which is the failure this form has already been bitten
 * by once.
 */

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

export function RepeatFields() {
  const [repeats, setRepeats] = useState(false);
  const [frequency, setFrequency] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('WEEKLY');
  const [endsWith, setEndsWith] = useState<'count' | 'date'>('count');

  return (
    <section className="space-y-4" data-testid="repeat-fields">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Repeats
      </h2>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="repeats"
          checked={repeats}
          onChange={(event) => setRepeats(event.target.checked)}
          className="h-4 w-4 rounded border-input"
          data-testid="repeats-toggle"
        />
        Book this as a recurring job
      </label>

      {!repeats ? null : (
        <div className="space-y-4 rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">
            Each occurrence is booked as its own job — assign, price and cancel
            them individually. The time stays the same in local terms across a
            clock change.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Frequency</span>
              <select
                name="repeatFrequency"
                value={frequency}
                onChange={(event) =>
                  setFrequency(event.target.value as typeof frequency)
                }
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </label>

            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Every</span>
              <Input
                type="number"
                name="repeatInterval"
                min={1}
                max={52}
                defaultValue={1}
                aria-describedby="repeat-interval-hint"
              />
              <span id="repeat-interval-hint" className="text-xs text-muted-foreground">
                {frequency === 'DAILY'
                  ? 'days'
                  : frequency === 'WEEKLY'
                    ? 'weeks'
                    : 'months'}
              </span>
            </label>
          </div>

          {frequency !== 'WEEKLY' ? null : (
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">On</legend>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((day) => (
                  <label
                    key={day.value}
                    className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      name="repeatWeekday"
                      value={day.value}
                      className="h-3.5 w-3.5 rounded border-input"
                    />
                    {day.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Leave all unticked to repeat on the same weekday as the first job.
              </p>
            </fieldset>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Ends</legend>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="repeatEndsWith"
                value="count"
                checked={endsWith === 'count'}
                onChange={() => setEndsWith('count')}
                className="h-4 w-4"
              />
              After
              <Input
                type="number"
                name="repeatCount"
                min={1}
                max={366}
                defaultValue={4}
                className="w-24"
                disabled={endsWith !== 'count'}
              />
              jobs
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="repeatEndsWith"
                value="date"
                checked={endsWith === 'date'}
                onChange={() => setEndsWith('date')}
                className="h-4 w-4"
              />
              On
              <Input
                type="date"
                name="repeatEndsOn"
                className="w-44"
                disabled={endsWith !== 'date'}
              />
            </label>

            <p className="text-xs text-muted-foreground">
              At most 366 jobs, whichever you choose.
            </p>
          </fieldset>
        </div>
      )}
    </section>
  );
}
