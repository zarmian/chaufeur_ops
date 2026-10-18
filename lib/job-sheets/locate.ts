import { extractPostcode, preferredAddressText } from '../places/types';

/**
 * Putting a sheet's address on the map.
 *
 * An address read off a PDF is a line of text somebody at an agency typed. It
 * is frequently good enough to read and not good enough to price or navigate
 * to: "Royal Albert hall Kensington Gore, South Kensington London" has no
 * house number, the wrong capitalisation and a comma in the wrong place, and
 * it carries no coordinates at all. A job booked from it prices off whatever
 * postcode a regular expression could find in it, and a driver gets the text.
 *
 * So when a Places provider is configured, each address is looked up and the
 * result — the formatted address, the postcode, the coordinates, and the saved
 * Location — is kept alongside what the sheet said.
 *
 * **Alongside, not instead.** The sheet's own words are never thrown away.
 * Two reasons: an operator comparing a pre-filled form against the page in
 * front of them needs to see the same thing in both, and a lookup that
 * confidently returns the wrong building is a worse failure than one that
 * returns nothing — the address still reads plausibly, and the car goes to the
 * wrong place.
 *
 * The guard against that is the postcode. These sheets nearly always carry
 * one, and it is the one part of a scruffy address that is unambiguous: if the
 * sheet says SW7 2AP and the lookup answers with somewhere in W1, the lookup
 * found a different place and none of it is taken.
 */

/** What a provider offered for an address. */
export interface PlaceCandidate {
  address: string;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
  locationId: string | null;
}

/** An address, as located as it can be. */
export interface LocatedAddress {
  /** What the booking form should show. */
  text: string;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
  locationId: string | null;
  /** The sheet's own words, always. */
  sheetText: string;
  /** Null when the lookup was taken; otherwise why it was not. */
  refused: RefusedMatch | null;
}

export type RefusedMatch =
  /** No provider configured, so nothing was looked up. */
  | 'NOT_LOOKED_UP'
  /** The provider found nothing for this address. */
  | 'NOT_FOUND'
  /**
   * The provider found somewhere else.
   *
   * A different postcode means a different place, however well the words
   * matched — and the words match surprisingly often, because every London
   * hotel is on a street whose name appears in a hundred addresses.
   */
  | 'DIFFERENT_POSTCODE';

/** Said to the operator, so a missing pin on a job is never a mystery. */
export const REFUSAL_TEXT: Record<RefusedMatch, string> = {
  NOT_LOOKED_UP: 'not checked — no address lookup is configured',
  NOT_FOUND: 'the address lookup did not recognise this',
  DIFFERENT_POSTCODE:
    'the address lookup found a different postcode, so its answer was ignored',
};

/**
 * What to keep: the sheet's address, the provider's, or parts of each.
 *
 * Pure, and the only place the decision is made.
 */
export function applyMatch(
  sheetText: string,
  candidate: PlaceCandidate | null,
  refusedBecause: RefusedMatch | null = null,
): LocatedAddress {
  const ownPostcode = extractPostcode(sheetText);

  const unlocated = (refused: RefusedMatch): LocatedAddress => ({
    text: sheetText,
    postcode: ownPostcode,
    lat: null,
    lng: null,
    locationId: null,
    sheetText,
    refused,
  });

  if (refusedBecause) return unlocated(refusedBecause);
  if (!candidate) return unlocated('NOT_FOUND');

  const found = candidate.postcode ?? extractPostcode(candidate.address);

  /*
   * Both sides naming a postcode, and naming different ones, settles it. This
   * is the check that stops a plausible-looking wrong answer: the words in a
   * London address are shared by half the city, and the postcode is not.
   */
  if (ownPostcode && found && !samePostcode(ownPostcode, found)) {
    return unlocated('DIFFERENT_POSTCODE');
  }

  return {
    /*
     * `preferredAddressText` already owns this judgement for the booking form,
     * and it is the right one here: the provider's label wins only when
     * everything the sheet said survives inside it. An agency writing
     * "Terminal 5, Gate B" knows something Google's "Heathrow Airport" does
     * not, and a driver is sent `pickupText`.
     */
    text: preferredAddressText(sheetText, candidate.address),
    postcode: found ?? ownPostcode,
    lat: candidate.lat,
    lng: candidate.lng,
    locationId: candidate.locationId,
    sheetText,
    refused: null,
  };
}

/** Compared without spacing or case, which are the only ways two are written. */
function samePostcode(left: string, right: string): boolean {
  const flat = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return flat(left) === flat(right);
}

/** Both of a sheet's addresses, once looked up. */
export interface LocatedAddresses {
  pickup: LocatedAddress | null;
  dropoff: LocatedAddress | null;
}
