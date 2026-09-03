import { describe, expect, it } from 'vitest';
import { filterOptions, worthFiltering } from './option-filter';

/**
 * The two rules a search box over a `<select>` has to get right.
 *
 * The second one is the reason this is tested at all: a native select whose
 * selected `<option>` leaves the DOM loses its value without saying anything,
 * so a dispatcher who picks a driver and then types would submit a job with
 * nobody on it and see nothing wrong.
 */

const DRIVERS = [
  { value: 'd1', label: 'Marek Kowalski · DRV-001' },
  { value: 'd2', label: "Siobhán O'Brien · DRV-002" },
  { value: 'd3', label: 'Ahmed Hassan · DRV-003' },
  { value: 'd4', label: 'Marie Dubois · DRV-004' },
];

describe('filterOptions', () => {
  it('shows everything when nothing has been typed', () => {
    expect(filterOptions(DRIVERS, '')).toHaveLength(4);
    expect(filterOptions(DRIVERS, '   ')).toHaveLength(4);
  });

  it('narrows to what was typed, anywhere in the label', () => {
    expect(filterOptions(DRIVERS, 'hassan').map((o) => o.value)).toEqual(['d3']);
    // A reference is as good a search as a name, and often faster to type.
    expect(filterOptions(DRIVERS, 'DRV-002').map((o) => o.value)).toEqual(['d2']);
  });

  it('keeps more than one match, in the order they were given', () => {
    // Already sorted by name upstream; re-ranking would move a familiar list
    // around under somebody who knows where things are.
    expect(filterOptions(DRIVERS, 'mar').map((o) => o.value)).toEqual(['d1', 'd4']);
  });

  it('ignores case, spacing and punctuation', () => {
    // "O'Brien" typed without the apostrophe is the same person.
    expect(filterOptions(DRIVERS, 'obrien').map((o) => o.value)).toEqual(['d2']);
    expect(filterOptions(DRIVERS, 'MAREK  ').map((o) => o.value)).toEqual(['d1']);
    expect(filterOptions(DRIVERS, 'drv 003').map((o) => o.value)).toEqual(['d3']);
  });

  it('never filters out the option that is currently selected', () => {
    /*
     * The rule this file exists for. Typing a search that excludes the chosen
     * driver must not remove them from the DOM, or the select quietly reverts
     * to nothing and the job is booked unassigned.
     */
    const shown = filterOptions(DRIVERS, 'hassan', 'd1');

    expect(shown.map((o) => o.value)).toEqual(['d1', 'd3']);
    expect(shown.some((o) => o.value === 'd1')).toBe(true);
  });

  it('does not duplicate the selection when it also matches', () => {
    expect(filterOptions(DRIVERS, 'marek', 'd1').map((o) => o.value)).toEqual([
      'd1',
    ]);
  });

  it('returns nothing findable when nothing matches and nothing is chosen', () => {
    expect(filterOptions(DRIVERS, 'zzzz')).toEqual([]);
  });
});

describe('worthFiltering', () => {
  it('leaves a short list alone', () => {
    // A search box for four vehicles is one more thing on the screen and
    // nothing to find.
    expect(worthFiltering(0)).toBe(false);
    expect(worthFiltering(4)).toBe(false);
  });

  it('offers a search once the list stops fitting in a glance', () => {
    expect(worthFiltering(8)).toBe(true);
    expect(worthFiltering(195)).toBe(true);
  });
});
