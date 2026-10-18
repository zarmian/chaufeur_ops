import { describe, expect, it } from 'vitest';
import { candidateLabels, labelFor, lessonFrom, stillTrusted } from './learn';
import { readJobSheet } from './read';
import { EMPTY_DRAFT } from './types';

/**
 * Learning a sender's wording from what an operator does on the form.
 *
 * The behaviour under test is mostly a refusal. An install that learns eagerly
 * gets worse over time and does it quietly: a label picked up from a
 * coincidence reads the wrong box on every later sheet, and because the form
 * then arrives looking complete, nobody checks it.
 */

const SHEET = [
  'ELMFIELD CHAUFFEURS - JOB SHEET',
  'Uplift On:     8 January 2027',
  'Uplift At:     22:40',
  'Our Ref:       EC-4471',
  'Guest:         Marianne Okafor',
  'From:          The Connaught, Carlos Place, London, W1K 2AL',
  'To:            Claridge\'s, Brook Street, London, W1K 4HR',
].join('\n');

describe('labelFor', () => {
  it('works out the label behind a value the operator typed', () => {
    /*
     * The growth path. This agency says "Uplift On:", which nothing in the
     * dictionary knows, so the date arrived blank and somebody typed it. The
     * value they typed is `2027-01-08`; the page says `8 January 2027`. Only
     * running the field's own parser over each label can connect the two.
     */
    expect(labelFor(SHEET, 'scheduledDate', '2027-01-08')).toEqual({
      label: 'Uplift On:',
      placement: 'after',
    });
    expect(labelFor(SHEET, 'scheduledTime', '22:40')).toEqual({
      label: 'Uplift At:',
      placement: 'after',
    });
  });

  it('learns a label for a name the dictionary does not know', () => {
    expect(labelFor(SHEET, 'passengerName', 'Marianne Okafor')).toEqual({
      label: 'Guest:',
      placement: 'after',
    });
  });

  it('finds nothing when the page does not say it', () => {
    /*
     * The common and correct answer: the operator knew something the sheet
     * does not contain. Nothing is learned and nothing is guessed.
     */
    expect(labelFor(SHEET, 'passengerName', 'Someone Else')).toBeNull();
    expect(labelFor(SHEET, 'flightNumber', 'BA117')).toBeNull();
  });

  it('learns nothing when the dictionary already reads the value', () => {
    /*
     * `From:` is already known for the pickup, so this field was never blank
     * and there is nothing to learn. Checking first matters: hunting for a
     * label anyway finds one, because a page this short has several boxes that
     * coincidentally sit above or beside the right answer.
     */
    expect(
      labelFor(SHEET, 'pickupText', 'The Connaught, Carlos Place, London, W1K 2AL'),
    ).toBeNull();
  });

  it('does not take a value for a label', () => {
    /*
     * The mistake the first draft made, and the reason for the digit test. On
     * this sheet `EC-4471` is the reference, and the passenger's name happens
     * to sit one line below it in the same column — so "learn whatever box is
     * above the answer" concluded that the reference box is where names live,
     * and would have read every later sheet that way.
     */
    const alias = labelFor(SHEET, 'passengerName', 'Marianne Okafor');

    expect(alias?.label).toBe('Guest:');
  });
});

describe('candidateLabels', () => {
  it('offers the labels on the page and not the values', () => {
    const labels = candidateLabels(SHEET).map((candidate) => candidate.label);

    expect(labels).toContain('Uplift On:');
    expect(labels).toContain('Guest:');
    // Values, however heading-shaped. Anything carrying a digit is a
    // reference, a date, a time or a postcode, never a column heading.
    expect(labels).not.toContain('EC-4471');
    expect(labels).not.toContain('8 January 2027');
    expect(labels).not.toContain('22:40');
  });

  it('marks a short label as line-start only', () => {
    // `PU:` and `To:` are too common inside other text to be matched anywhere,
    // and too useful to leave out.
    const short = candidateLabels('To:   The Savoy').find(
      (candidate) => candidate.label === 'To:',
    );

    expect(short?.lineStart).toBe(true);
  });
});

describe('lessonFrom', () => {
  const read = readJobSheet(SHEET);

  it('learns the labels behind the fields the operator had to fill in', () => {
    // What a first sheet from a new agency looks like: four fields read from
    // labels the dictionary knows, three typed by hand.
    const lesson = lessonFrom(SHEET, read.draft, read.sources, {
      scheduledDate: '2027-01-08',
      scheduledTime: '22:40',
      passengerName: 'Marianne Okafor',
    });

    expect(lesson.taught).toEqual([
      { field: 'scheduledDate', alias: { label: 'Uplift On:', placement: 'after' } },
      { field: 'scheduledTime', alias: { label: 'Uplift At:', placement: 'after' } },
      { field: 'passengerName', alias: { label: 'Guest:', placement: 'after' } },
    ]);
  });

  it('counts a value left alone as the label earning its keep', () => {
    const lesson = lessonFrom(SHEET, read.draft, read.sources, {
      pickupText: read.draft.pickupText!,
    });

    expect(lesson.kept).toEqual([
      { field: 'pickupText', source: { label: 'From:', placement: 'paragraph' } },
    ]);
    expect(lesson.changed).toEqual([]);
  });

  it('never invents a label from a value the operator changed', () => {
    /*
     * The refusal that keeps this safe. The operator has replaced the pickup
     * with the destination's address — which happens, because the agency
     * mixed them up on the sheet. A system that learned from disagreement
     * would conclude that `To:` is where the pickup lives and read every
     * later sheet backwards.
     */
    const lesson = lessonFrom(SHEET, read.draft, read.sources, {
      pickupText: read.draft.dropoffText!,
    });

    expect(lesson.taught).toEqual([]);
    expect(lesson.changed).toEqual([
      { field: 'pickupText', source: { label: 'From:', placement: 'paragraph' } },
    ]);
  });

  it('judges only the fields the form sent back', () => {
    // An edit elsewhere in the system is not evidence about a label.
    const lesson = lessonFrom(SHEET, read.draft, read.sources, {});

    expect(lesson).toEqual({ kept: [], changed: [], taught: [] });
  });

  it('learns nothing from a sheet it could not read at all', () => {
    const lesson = lessonFrom('A letter about something else.', EMPTY_DRAFT, {}, {
      scheduledDate: '2027-01-08',
    });

    expect(lesson.taught).toEqual([]);
  });
});

describe('stillTrusted', () => {
  it('keeps a label that has never misfired', () => {
    expect(stillTrusted({ confirmed: 0, corrected: 0 })).toBe(true);
    expect(stillTrusted({ confirmed: 9, corrected: 0 })).toBe(true);
  });

  it('keeps a label through its first corrections', () => {
    /*
     * One correction is not evidence. An operator also corrects a value the
     * agency got wrong, and retiring a good label on that basis loses the
     * field for every later sheet.
     */
    expect(stillTrusted({ confirmed: 0, corrected: 1 })).toBe(true);
    expect(stillTrusted({ confirmed: 1, corrected: 1 })).toBe(true);
  });

  it('retires one that is changed more often than it is kept', () => {
    expect(stillTrusted({ confirmed: 1, corrected: 4 })).toBe(false);
    expect(stillTrusted({ confirmed: 2, corrected: 3 })).toBe(false);
  });

  it('keeps one that is mostly right', () => {
    expect(stillTrusted({ confirmed: 8, corrected: 2 })).toBe(true);
  });
});
