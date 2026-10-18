import { describe, expect, it } from 'vitest';
import { applyMatch, type PlaceCandidate } from './locate';

/**
 * Deciding whether an address lookup found the same place the sheet meant.
 *
 * The failure this exists to prevent is not a missed match — that leaves the
 * job exactly as it would have been without any lookup at all. It is a
 * confident wrong one: an address that still reads plausibly, now carrying the
 * coordinates and postcode of a different building, pricing off the wrong zone
 * and sending a driver to the wrong street.
 */

const westin: PlaceCandidate = {
  address: 'The Westin London City, 60 Upper Thames St, London EC4V 3AD, UK',
  postcode: 'EC4V 3AD',
  lat: 51.5103,
  lng: -0.0953,
  locationId: 'loc_westin',
};

describe('applyMatch', () => {
  it('takes the lookup when the postcodes agree', () => {
    const located = applyMatch(
      'The Westin London City, 60 Upper Thames Street, London, EC4V 3AD',
      westin,
    );

    expect(located.refused).toBeNull();
    expect(located.postcode).toBe('EC4V 3AD');
    expect(located.lat).toBe(51.5103);
    expect(located.locationId).toBe('loc_westin');
  });

  it('keeps the sheet’s wording when it says more than the lookup', () => {
    /*
     * "Street" against "St" is enough for the sheet's words to survive, and
     * that is the right way round: a driver is sent `pickupText`, and an
     * agency writing "Terminal 5, Gate B" knows something "Heathrow Airport"
     * does not. The coordinates are taken either way — they are what the
     * lookup is for.
     */
    const located = applyMatch(
      'The Westin London City, 60 Upper Thames Street, London, EC4V 3AD',
      westin,
    );

    expect(located.text).toContain('Upper Thames Street');
    expect(located.lat).toBe(51.5103);
  });

  it('takes the lookup’s wording when it is strictly more complete', () => {
    const located = applyMatch('Royal Albert Hall', {
      address: 'Royal Albert Hall, Kensington Gore, South Kensington, London SW7 2AP, UK',
      postcode: 'SW7 2AP',
      lat: 51.5009,
      lng: -0.1773,
      locationId: null,
    });

    expect(located.text).toContain('Kensington Gore');
    expect(located.postcode).toBe('SW7 2AP');
  });

  it('refuses a lookup that answers with a different postcode', () => {
    /*
     * The guard that matters. Street names in London are shared by half the
     * city, so a wrong building matches on words far more often than it has
     * any right to — and the postcode is the one part of a scruffy address
     * that cannot be read two ways.
     */
    const located = applyMatch(
      'The Dorchester, Park Lane, London, W1K 1QA',
      { ...westin, address: 'Park Lane, London EC4V 3AD', postcode: 'EC4V 3AD' },
    );

    expect(located.refused).toBe('DIFFERENT_POSTCODE');
    // Nothing of the lookup survives: not the words, not the pin.
    expect(located.text).toBe('The Dorchester, Park Lane, London, W1K 1QA');
    expect(located.postcode).toBe('W1K 1QA');
    expect(located.lat).toBeNull();
    expect(located.locationId).toBeNull();
  });

  it('ignores how a postcode is spaced or cased', () => {
    const located = applyMatch('Somewhere, ec4v3ad', westin);

    expect(located.refused).toBeNull();
    expect(located.lat).toBe(51.5103);
  });

  it('accepts a lookup when the sheet names no postcode', () => {
    // Nothing to contradict it, and an address with coordinates is worth more
    // than one without. The operator still sees it on the form.
    const located = applyMatch('Royal Albert hall Kensington Gore', {
      address: 'Royal Albert Hall, Kensington Gore, London SW7 2AP, UK',
      postcode: 'SW7 2AP',
      lat: 51.5009,
      lng: -0.1773,
      locationId: null,
    });

    expect(located.refused).toBeNull();
    expect(located.postcode).toBe('SW7 2AP');
  });

  it('keeps the sheet’s own postcode when the lookup offers none', () => {
    const located = applyMatch('Somewhere out of the way, EC4V 3AD', {
      address: 'Somewhere out of the way',
      postcode: null,
      lat: 51.5,
      lng: -0.09,
      locationId: null,
    });

    expect(located.refused).toBeNull();
    expect(located.postcode).toBe('EC4V 3AD');
  });

  it('leaves the address exactly as read when nothing was found', () => {
    /*
     * Which is the same job the booking would have been without any lookup —
     * a missed match costs nothing, and that is why the checks above can
     * afford to be strict.
     */
    const located = applyMatch('A private address the operator knows, SW7 2AP', null);

    expect(located.refused).toBe('NOT_FOUND');
    expect(located.text).toBe('A private address the operator knows, SW7 2AP');
    expect(located.postcode).toBe('SW7 2AP');
    expect(located.lat).toBeNull();
  });

  it('says when no lookup was configured, rather than implying one failed', () => {
    // An install with no Places key is not a broken one, and the difference
    // decides whether somebody goes looking for a fault.
    const located = applyMatch('The Savoy, Strand', null, 'NOT_LOOKED_UP');

    expect(located.refused).toBe('NOT_LOOKED_UP');
    expect(located.text).toBe('The Savoy, Strand');
  });

  it('always keeps what the sheet said', () => {
    // The operator checks a pre-filled form against the page in front of them,
    // and has to be able to see the same thing in both.
    for (const candidate of [westin, null]) {
      const located = applyMatch('The Westin, EC4V 3AD', candidate);
      expect(located.sheetText).toBe('The Westin, EC4V 3AD');
    }
  });
});
