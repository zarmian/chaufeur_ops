import { describe, expect, it } from 'vitest';
import { belongsToVehicle, isFilable, parseTypedDate } from './documents';

/**
 * Filing a document from a chat.
 *
 * The date is the part that has to be right. Compliance is judged on it, an
 * expired badge blocks assignment, and nobody checks a stored date against
 * the certificate afterwards — so a misread is wrong in the one direction
 * that never gets caught. Every ambiguous form is refused and asked again
 * rather than guessed.
 */

describe('reading a date a driver typed', () => {
  it('takes the form printed on a UK document', () => {
    expect(parseTypedDate('04/09/2027')).toBe('2027-09-04');
    expect(parseTypedDate('4/9/2027')).toBe('2027-09-04');
    expect(parseTypedDate('04-09-2027')).toBe('2027-09-04');
    expect(parseTypedDate('04.09.2027')).toBe('2027-09-04');
    expect(parseTypedDate(' 04/09/2027 ')).toBe('2027-09-04');
  });

  it('reads day first, not month first', () => {
    /*
     * The one that would be silently wrong. `04/09/2027` is the 4th of
     * September on every UK licence and badge, and the 9th of April to a
     * parser that assumes American order — five months of validity that does
     * not exist, or a driver blocked from work five months early.
     */
    expect(parseTypedDate('04/09/2027')).toBe('2027-09-04');
    expect(parseTypedDate('31/12/2027')).toBe('2027-12-31');
  });

  it('takes ISO too, because somebody will type it', () => {
    expect(parseTypedDate('2027-09-04')).toBe('2027-09-04');
  });

  it('reads a two-digit year as this century', () => {
    // Nothing being filed here expires in 1927.
    expect(parseTypedDate('04/09/27')).toBe('2027-09-04');
  });

  it('refuses a date that does not exist', () => {
    // Rather than rolling 31 February into March, which would store a date
    // the document does not carry.
    expect(parseTypedDate('31/02/2027')).toBeNull();
    expect(parseTypedDate('32/01/2027')).toBeNull();
    expect(parseTypedDate('04/13/2027')).toBeNull();
    expect(parseTypedDate('00/09/2027')).toBeNull();
  });

  it('refuses anything it cannot read, rather than guessing', () => {
    for (const input of [
      '',
      'next september',
      '2027',
      '04/09',
      'soon',
      '04/09/2027 or thereabouts',
    ]) {
      expect(parseTypedDate(input), input).toBeNull();
    }
  });
});

describe('what a driver may file', () => {
  it('covers their own papers and the car they drive', () => {
    for (const type of ['DVLA_LICENCE', 'PHV_BADGE', 'DBS']) {
      expect(isFilable(type), type).toBe(true);
      expect(belongsToVehicle(type as never), type).toBe(false);
    }
    for (const type of ['PHV_VEHICLE', 'MOT', 'INSURANCE', 'V5_LOGBOOK']) {
      expect(isFilable(type), type).toBe(true);
      expect(belongsToVehicle(type as never), type).toBe(true);
    }
  });

  it('does not offer "Other"', () => {
    /*
     * Deliberate. An untyped document files against nothing the compliance
     * screen reads, so it would look to the driver like they had complied and
     * to the office like they had not — and the chasing would carry on.
     */
    expect(isFilable('OTHER')).toBe(false);
  });
});
