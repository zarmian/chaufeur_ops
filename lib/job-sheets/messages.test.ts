import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJobSheet } from './read';

/**
 * Reading a booking somebody typed, rather than one software printed.
 *
 * The team shares a job in a WhatsApp group, it goes out to find a driver, and
 * once a driver is fixed the full details are posted back. That last message
 * is the complete record and the one worth reading — composed by a person to
 * be forwarded, so consistently laid out, but written the way people write
 * rather than the way booking software prints.
 *
 * The machinery is the same as for a PDF: labels, placements, parsers. What
 * differs is how far a label can be trusted, and that is the whole content of
 * these tests.
 */

const confirmation = [
  'CONFIRMED ✅',
  '',
  'Date: 24 Oct 2026',
  'Time: 14:30',
  'Pick up: The Connaught, Carlos Place, London, W1K 2AL',
  'Drop off: Heathrow Terminal 5, TW6 2GA',
  'Passenger: Mr A Whitcombe',
  'Contact: 07700 900482',
  'Pax: 2',
  'Luggage: 3',
  'Flight: BA117',
  'Ref: WLX-4471',
  'Car: Exec saloon',
  'Notes: Meet in the lobby, passenger has a cello.',
].join('\n');

describe('a booking typed into a message', () => {
  const read = readJobSheet(confirmation, { source: 'message' });

  it('reads the whole thing', () => {
    expect(read.missing).toEqual([]);
    expect(read.draft).toMatchObject({
      scheduledDate: '2026-10-24',
      scheduledTime: '14:30',
      pickupText: 'The Connaught, Carlos Place, London, W1K 2AL',
      pickupPostcode: 'W1K 2AL',
      dropoffText: 'Heathrow Terminal 5, TW6 2GA',
      passengerName: 'A Whitcombe',
      passengerPhone: '07700 900482',
      passengerCount: '2',
      luggageCount: '3',
      flightNumber: 'BA117',
      customerReference: 'WLX-4471',
      vehicleRequested: 'Exec saloon',
      jobType: 'AIRPORT_TRANSFER',
    });
  });

  it('reads almost none of it as a printed sheet', () => {
    /*
     * The reason the two vocabularies exist. Bare `Date:`, `Time:`, `Pick up:`
     * and `Ref:` are refused on a printed sheet on purpose — a sheet carries
     * several dates and prints every box whether or not it was filled, so the
     * bare label is as likely to be `Booked On:` or the one beside
     * `Signature:`. Reading the wrong date puts a car out on the wrong day.
     */
    const asSheet = readJobSheet(confirmation);

    expect(asSheet.draft.scheduledDate).toBeNull();
    expect(asSheet.draft.pickupText).toBeNull();
    expect(asSheet.missing.length).toBeGreaterThan(0);
  });

  it('defaults to the stricter reading', () => {
    // A caller that has not thought about where the text came from gets the
    // one that refuses rather than the one that guesses.
    expect(readJobSheet(confirmation).draft.scheduledDate).toBe(
      readJobSheet(confirmation, { source: 'sheet' }).draft.scheduledDate,
    );
  });
});

describe('labels that hide inside other labels', () => {
  it('does not read the driver as the passenger', () => {
    /*
     * Found by writing the first example out. "Driver Name: Amara Okafor"
     * contains `Name:`, and the passenger's name is what goes on the board
     * held up in an arrivals hall — so a driver read as the passenger is a
     * board with the wrong name on it, held up for somebody who never
     * answers.
     */
    const read = readJobSheet(
      [
        'Date: 24 Oct 2026',
        'Time: 14:30',
        'Pick up: The Savoy',
        'Drop off: Heathrow T5',
        'Driver Name: Amara Okafor',
      ].join('\n'),
      { source: 'message' },
    );

    expect(read.draft.passengerName).toBeNull();
  });

  it('does not read a flight number as a telephone number', () => {
    // `Flight Number:` contains `Number:`. The phone parser happens to refuse
    // a flight code for being too short, but that is luck rather than a rule.
    const read = readJobSheet(
      ['Pick up: The Savoy', 'Flight Number: BA117'].join('\n'),
      { source: 'message' },
    );

    expect(read.draft.passengerPhone).toBeNull();
    expect(read.draft.flightNumber).toBe('BA117');
  });

  it('still reads a label that is spelled out in full', () => {
    // Pinning `Time:` to the start of a line must not lose "Pickup Time:",
    // which is why the spelled-out form is listed ahead of the bare one.
    const read = readJobSheet(
      ['Pickup Time: 09:05', 'Pick up: The Savoy'].join('\n'),
      { source: 'message' },
    );

    expect(read.draft.scheduledTime).toBe('09:05');
  });
});

describe('what a message still refuses', () => {
  it('will not guess an all-numeric date, however it arrives', () => {
    /*
     * The refusals are about the value, not the source. `24/10/2026` and
     * `10/24/2026` are the same characters and different months whether a
     * printer or a person produced them.
     */
    const read = readJobSheet(
      ['Date: 10/11/2026', 'Pick up: The Savoy', 'Drop off: T5'].join('\n'),
      { source: 'message' },
    );

    expect(read.draft.scheduledDate).toBeNull();
    expect(read.missing).toContain('the pickup date');
  });

  it('leaves the price alone when nobody named one', () => {
    const read = readJobSheet(confirmation, { source: 'message' });

    expect(read.draft.clientPrice).toBeNull();
  });

  it('says what it could not find', () => {
    // A half-typed message is normal — somebody sounding out whether a car is
    // free. It should produce what it has and name the gaps, not refuse.
    const read = readJobSheet(
      ['Need a car tomorrow', 'Pick up: The Savoy'].join('\n'),
      { source: 'message' },
    );

    expect(read.draft.pickupText).toBe('The Savoy');
    expect(read.missing).toEqual([
      'the pickup date',
      'the pickup time',
      'the destination',
    ]);
  });
});

describe('a real confirmation, as this office writes it', () => {
  /*
   * The fixture is the shape of an actual message from the team's group, with
   * every name, number, registration and the company itself replaced. The
   * shape is what matters and the shape is exact: the blank `Contact:` under
   * the passenger, the filled one under the chauffeur, the missing space
   * after `PICK UP:`, the date written all in numbers, and the time on its
   * own line under it.
   */
  const message = readFileSync(
    join(__dirname, '__fixtures__', 'confirmation-message.txt'),
    'utf8',
  );

  const read = readJobSheet(message, { source: 'message', dateOrder: 'DMY' });

  it('reads the whole booking', () => {
    expect(read.missing).toEqual([]);
    expect(read.draft).toMatchObject({
      scheduledDate: '2026-10-20',
      scheduledTime: '13:15',
      pickupText: '14 Pembroke Gardens W8 6HS',
      pickupPostcode: 'W8 6HS',
      dropoffText: 'Northfleet freight depot, woolwich London, SE18 6AN',
      dropoffPostcode: 'SE18 6AN',
      passengerName: 'Adeyemi',
      customerReference: 'AC-00412',
      clientPrice: '100.00',
      vehicleRequested: 'Mercedes-Benz V-Class',
      jobType: 'TRANSFER',
    });
  });

  it('does not give the chauffeur’s mobile as the passenger’s', () => {
    /*
     * The one the real message got wrong, and the reason blocks exist.
     *
     * `Contact:` appears twice — blank under `Passenger:`, filled under
     * `CHAUFFEUR:`. Reading rightwards found the blank one, moved on, and
     * took the driver's. That is not merely the wrong field: `lib/tracking.ts`
     * withholds a driver's number from the passenger on purpose, so a
     * forwarded link does not leave an owner-driver's mobile with a client.
     * This would have handed it over as the client's own contact.
     */
    expect(read.draft.passengerPhone).toBeNull();
    expect(JSON.stringify(read.draft)).not.toContain('07700900461');
  });

  it('refuses the date when nobody has said which way round it is', () => {
    /*
     * `20-10-2026` is only readable because this source has declared itself
     * day-first. Without that it is indistinguishable from a month-first
     * date, and a booking a month out is worse than a blank field.
     */
    const guessing = readJobSheet(message, { source: 'message' });

    expect(guessing.draft.scheduledDate).toBeNull();
    expect(guessing.missing).toContain('the pickup date');
  });

  it('keeps the price out of the notes', () => {
    /*
     * The message ends `Note:` and then `Pay:£100 all in` on the line below,
     * with no space after that colon. Without noticing the second label, the
     * note carries a figure nobody will ever read as money and the price
     * stays empty.
     */
    expect(read.draft.notes).toBeNull();
    expect(read.sources.clientPrice?.label).toBe('Pay:');
  });

  it('takes the passenger from the passenger line, not the chauffeur line', () => {
    expect(read.draft.passengerName).toBe('Adeyemi');
  });
});
