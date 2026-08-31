import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  issueNameBoardToken,
  nameBoardsForDay,
  reissueNameBoardToken,
  resolveNameBoard,
} from './name-board-store';

/**
 * Issuing and redeeming a name board's link, against a real database.
 *
 * The shape of the board is covered without a database in
 * `name-board.test.ts`. What only this can prove is the part the token
 * exists for: that a link resolves to exactly one job's passenger, that it
 * stops resolving when the job is called off, and that reissuing takes the
 * old one out of circulation.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

/** A century of its own — see the note in `dispatch.integration.test.ts`. */
const YEAR = 2113;
const DAY = new Date(`${YEAR}-03-08T12:00:00Z`);

function at(hour: number): Date {
  return new Date(Date.UTC(YEAR, 2, 8, hour, 0, 0));
}

describe.skipIf(!DATABASE_AVAILABLE)('name board links', () => {
  const jobIds: string[] = [];

  async function makeJob(input: {
    jobType?: string;
    passengerName?: string | null;
    hour?: number;
    status?: string;
  }): Promise<string> {
    if (!raw) throw new Error('no database');

    const job = await raw.job.create({
      data: {
        reference: `NB-${stamp}-${jobIds.length}`,
        jobType: (input.jobType ?? 'AIRPORT_TRANSFER') as never,
        status: (input.status ?? 'PENDING') as never,
        scheduledAt: at(input.hour ?? 9),
        pickupText: 'Heathrow Terminal 5',
        dropoffText: 'The Dorchester',
        passengerName:
          input.passengerName === undefined ? `Mr Ali ${stamp}` : input.passengerName,
        clientPricePence: 12_550,
      },
    });
    jobIds.push(job.id);
    return job.id;
  }

  beforeAll(async () => {
    if (raw) await raw.$connect();
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.$disconnect();
  });

  it('mints a link for an airport transfer with a passenger', async () => {
    const jobId = await makeJob({});
    const token = await issueNameBoardToken(jobId);

    expect(token).toBeTruthy();
    // 24 bytes, base64url. Guessing has to be hopeless rather than unlikely:
    // the URL is the whole credential.
    expect(token!.length).toBeGreaterThanOrEqual(30);
  });

  it('hands back the same link every time it is asked', async () => {
    /*
     * The property a driver depends on. They save the board to their home
     * screen at six in the morning, the job is edited twice and re-sent, and
     * the thing they hold up at eleven still works.
     */
    const jobId = await makeJob({});
    const first = await issueNameBoardToken(jobId);
    const second = await issueNameBoardToken(jobId);
    expect(second).toBe(first);
  });

  it('refuses anything that is not an airport transfer', async () => {
    const transfer = await makeJob({ jobType: 'TRANSFER' });
    expect(await issueNameBoardToken(transfer)).toBeNull();
  });

  it('refuses a job with nobody named on it', async () => {
    const nameless = await makeJob({ passengerName: null });
    expect(await issueNameBoardToken(nameless)).toBeNull();
  });

  it('resolves a link to that job and no other', async () => {
    const mine = await makeJob({ passengerName: `Ms Chen ${stamp}` });
    const other = await makeJob({ passengerName: `Dr Okafor ${stamp}` });

    const token = await issueNameBoardToken(mine);
    const board = await resolveNameBoard(token!);

    expect(board?.jobId).toBe(mine);
    expect(board?.name).toBe(`Ms Chen ${stamp}`);
    expect(board?.jobId).not.toBe(other);
  });

  it('shows the name as it stands now, not as it was when issued', async () => {
    // A misspelling corrected at nine has to reach a board already open on a
    // driver's phone.
    const jobId = await makeJob({ passengerName: 'Mr Jonh Smith' });
    const token = await issueNameBoardToken(jobId);

    await raw!.job.update({
      where: { id: jobId },
      data: { passengerName: 'Mr John Smith' },
    });

    expect((await resolveNameBoard(token!))?.name).toBe('Mr John Smith');
  });

  it('stops resolving once the job is called off', async () => {
    // A board for a job that is not happening is a driver sent to arrivals
    // for nobody.
    const jobId = await makeJob({});
    const token = await issueNameBoardToken(jobId);
    expect(await resolveNameBoard(token!)).not.toBeNull();

    await raw!.job.update({ where: { id: jobId }, data: { status: 'CANCELLED' } });
    expect(await resolveNameBoard(token!)).toBeNull();
  });

  it('takes an old link out of circulation when reissued', async () => {
    // The reason the token is a column rather than a signature over the job
    // id: a link left in the wrong group chat can be revoked without touching
    // the booking.
    const jobId = await makeJob({});
    const first = await issueNameBoardToken(jobId);
    const second = await reissueNameBoardToken(jobId);

    expect(second).not.toBe(first);
    expect(await resolveNameBoard(first!)).toBeNull();
    expect((await resolveNameBoard(second!))?.jobId).toBe(jobId);
  });

  it('finds nothing behind a token somebody made up', async () => {
    expect(await resolveNameBoard('not-a-real-token')).toBeNull();
    expect(await resolveNameBoard('')).toBeNull();
    expect(await resolveNameBoard('   ')).toBeNull();
  });

  it('collects the day’s boards in pickup order', async () => {
    // The stack an office prints at six: the top sheet is the next car out.
    const late = await makeJob({ hour: 16, passengerName: `Late ${stamp}` });
    const early = await makeJob({ hour: 6, passengerName: `Early ${stamp}` });
    const road = await makeJob({
      hour: 8,
      jobType: 'TRANSFER',
      passengerName: `Road ${stamp}`,
    });
    const nameless = await makeJob({ hour: 10, passengerName: null });

    const boards = await nameBoardsForDay(DAY);
    const ids = boards.map((board) => board.jobId);

    // By id rather than by counting: every other test in this file books its
    // own airport transfer on this same day, so a count would be a tally of
    // whatever ran before rather than a statement about this one.
    expect(ids).toContain(early);
    expect(ids).toContain(late);
    expect(ids.indexOf(early)).toBeLessThan(ids.indexOf(late));

    // A road transfer is not a board, and neither is a job with nobody named
    // on it — a blank sheet in the middle of the stack is worse than a
    // shorter stack.
    expect(ids).not.toContain(road);
    expect(ids).not.toContain(nameless);
  });
});
