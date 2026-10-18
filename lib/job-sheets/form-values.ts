import type { LocatedAddress, LocatedAddresses } from './locate';
import type { JobSheetDraft } from './types';

/**
 * A read sheet as booking-form values.
 *
 * The join between this directory and the form, and deliberately the only one.
 * Nothing here writes to the database or decides anything: it produces the
 * strings the form holds, so that a sheet arrives as a filled-in booking form
 * and an operator presses Book — through the same validation, compliance
 * checks, pricing and clash warnings as a job typed by hand.
 *
 * What it does *not* fill in matters as much. No driver and no vehicle: those
 * are what run the licence, MOT and insurance checks against the pickup date,
 * and a sheet naming "V Class" is telling us a class of car, not which of ours
 * is free and legal that morning. No price, when the sheet names none.
 */

/** The fields of the booking form a sheet can speak to. */
export interface SheetFormValues {
  clientId: string;
  accountId: string;
  jobType: string;
  scheduledDate: string;
  scheduledTime: string;
  pickupText: string;
  pickupPostcode: string;
  /*
   * Coordinates and the saved location, when an address lookup recognised the
   * place. They are what the booking form's own address field carries, and
   * what makes a sheet's address worth the same as one somebody picked from
   * the dropdown — the postcode prices the job, and the pin is what every
   * distance and mapping feature reads.
   */
  pickupLat: string;
  pickupLng: string;
  pickupLocationId: string;
  dropoffText: string;
  dropoffPostcode: string;
  dropoffLat: string;
  dropoffLng: string;
  dropoffLocationId: string;
  passengerName: string;
  passengerPhone: string;
  passengerCount: string;
  luggageCount: string;
  flightNumber: string;
  customerReference: string;
  clientPrice: string;
  notes: string;
}

export interface SheetSenderDefaults {
  accountId: string | null;
  clientId: string | null;
}

export function sheetFormValues(
  draft: JobSheetDraft,
  sender: SheetSenderDefaults | null,
  located: LocatedAddresses = { pickup: null, dropoff: null },
): SheetFormValues {
  const pickup = address(located.pickup, draft.pickupText, draft.pickupPostcode);
  const dropoff = address(located.dropoff, draft.dropoffText, draft.dropoffPostcode);

  return {
    /*
     * From the sender, never from the page. An agency's sheet names the
     * passenger, not the company being invoiced — booker and client are
     * separate here, and for agency work the booker pays. Which of this
     * install's accounts that is cannot be read off the paper.
     */
    accountId: sender?.accountId ?? '',
    clientId: sender?.clientId ?? '',

    jobType: draft.jobType ?? 'TRANSFER',
    scheduledDate: draft.scheduledDate ?? '',
    scheduledTime: draft.scheduledTime ?? '',

    ...pickup('pickup'),
    ...dropoff('dropoff'),

    passengerName: draft.passengerName ?? '',
    passengerPhone: draft.passengerPhone ?? '',
    passengerCount: draft.passengerCount ?? '',
    luggageCount: draft.luggageCount ?? '',

    /*
     * Only carried when the job is an airport transfer, because that is the
     * only job type whose form shows the field — and the schema refuses a
     * flight number on anything else. The reader already types a sheet with a
     * flight on it as an airport transfer; this is the belt to that braces.
     */
    flightNumber: draft.jobType === 'AIRPORT_TRANSFER' ? (draft.flightNumber ?? '') : '',

    customerReference: draft.customerReference ?? '',
    clientPrice: draft.clientPrice ?? '',
    notes: notesWith(draft),
  };
}

/**
 * The sheet's notes, plus the car it asked for.
 *
 * The form has nowhere else to put a requested class — it chooses one of our
 * own vehicles — and dropping it would lose the one instruction that decides
 * which car goes. "MUST BE FULL SIZED SUV" is the whole content of some of
 * these sheets.
 */
function notesWith(draft: JobSheetDraft): string {
  const parts = [
    /*
     * Full stop included: the two parts are joined with a newline, and plenty
     * of places render notes as a single run of text. Without it this reads
     * "Vehicle requested: V Class MUST BE FULL SIZED SUV".
     */
    draft.vehicleRequested ? `Vehicle requested: ${draft.vehicleRequested}.` : '',
    draft.notes ?? '',
  ].filter((part) => part !== '');

  return parts.join('\n');
}

/**
 * One address, as the form's fields.
 *
 * Falls back to what the reader found whenever the lookup was not taken —
 * which covers an install with no provider, a provider that was down, and a
 * lookup that answered with a different postcode and was therefore ignored.
 * In every one of those the job is exactly what it would have been without
 * any lookup at all, which is why the checks around it can afford to be
 * strict.
 */
function address(
  located: LocatedAddress | null,
  text: string | null,
  postcode: string | null,
) {
  const resolved = {
    text: located?.text ?? text ?? '',
    postcode: located?.postcode ?? postcode ?? '',
    lat: located?.lat ?? null,
    lng: located?.lng ?? null,
    locationId: located?.locationId ?? null,
  };

  return <Side extends 'pickup' | 'dropoff'>(side: Side) =>
    ({
      [`${side}Text`]: resolved.text,
      [`${side}Postcode`]: resolved.postcode,
      [`${side}Lat`]: resolved.lat === null ? '' : String(resolved.lat),
      [`${side}Lng`]: resolved.lng === null ? '' : String(resolved.lng),
      [`${side}LocationId`]: resolved.locationId ?? '',
    }) as Record<`${Side}${'Text' | 'Postcode' | 'Lat' | 'Lng' | 'LocationId'}`, string>;
}
