import { randomBytes } from 'node:crypto';
import { endOfZonedDay, startOfZonedDay } from './dates';
import { getLocaleConfig } from './locale-store';
import { canHaveNameBoard, normaliseName } from './name-board';
import { prisma } from './prisma';

/**
 * Issuing and redeeming name-board links.
 *
 * Kept apart from `lib/name-board.ts` for the usual reason: that module is
 * pure and gets imported wherever a board is drawn, and this one reaches
 * Postgres.
 */

/**
 * 24 bytes.
 *
 * The same width `lib/telegram/linking.ts` uses for a driver's linking token,
 * and for the same reason: the URL is the only thing protecting what is
 * behind it, so guessing has to be hopeless rather than merely unlikely.
 */
const TOKEN_BYTES = 24;

export interface NameBoard {
  jobId: string;
  reference: string;
  name: string;
}

/**
 * This job's board link, minting one if it has never had a board.
 *
 * Lazily, so the column stays null on the overwhelming majority of jobs that
 * will never need one, and stable once issued — a driver who saved the link
 * to their home screen at six in the morning still has a working board at
 * eleven, and re-sending the job on Telegram does not invalidate the link
 * they are already holding up.
 *
 * Returns null when the job cannot have a board at all, which the caller
 * shows as no button rather than as a broken one.
 */
export async function issueNameBoardToken(jobId: string): Promise<string | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, jobType: true, passengerName: true, nameBoardToken: true },
  });

  if (!job || !canHaveNameBoard(job)) return null;
  if (job.nameBoardToken) return job.nameBoardToken;

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await prisma.job.update({ where: { id: jobId }, data: { nameBoardToken: token } });
  return token;
}

/**
 * A fresh link for a job that already had one.
 *
 * The reason a token is a column rather than a signature over the job id: a
 * link forwarded to the wrong person, or left in a group chat, can be taken
 * out of circulation without touching the booking.
 */
export async function reissueNameBoardToken(jobId: string): Promise<string | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, jobType: true, passengerName: true },
  });
  if (!job || !canHaveNameBoard(job)) return null;

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await prisma.job.update({ where: { id: jobId }, data: { nameBoardToken: token } });
  return token;
}

/**
 * The board behind a link, or null.
 *
 * Deliberately says nothing about *why* it found nothing. A cancelled job, a
 * revoked token and a string somebody made up all produce the same answer,
 * because the response to an unauthenticated request is not the place to
 * confirm that a token was once real.
 *
 * The name is read live rather than captured when the link was issued: a
 * misspelling corrected at nine o'clock has to reach a board already open on
 * a driver's phone, and it does, on their next refresh.
 */
export async function resolveNameBoard(token: string): Promise<NameBoard | null> {
  const trimmed = token.trim();
  if (trimmed === '') return null;

  const job = await prisma.job.findUnique({
    where: { nameBoardToken: trimmed },
    select: {
      id: true,
      reference: true,
      jobType: true,
      passengerName: true,
      status: true,
    },
  });

  if (!job || !canHaveNameBoard(job)) return null;
  // A board for a job that is not happening is a driver sent to arrivals for
  // nobody. The link stops working the moment it is called off.
  if (job.status === 'CANCELLED') return null;

  return {
    jobId: job.id,
    reference: job.reference,
    name: normaliseName(job.passengerName),
  };
}

/**
 * Every board wanted on a given day, in pickup order.
 *
 * For the office print run: a dispatcher at six in the morning wants the
 * day's boards as one stack in the order the cars go out, not eleven separate
 * downloads. Pickup order is what makes the stack usable — the top one is the
 * next car to leave.
 */
export async function nameBoardsForDay(day: Date): Promise<NameBoard[]> {
  const { timeZone } = await getLocaleConfig();

  const jobs = await prisma.job.findMany({
    where: {
      jobType: 'AIRPORT_TRANSFER',
      scheduledAt: {
        gte: startOfZonedDay(day, timeZone),
        lte: endOfZonedDay(day, timeZone),
      },
      status: { notIn: ['CANCELLED'] },
      // A board is the name. Without one there is nothing to print, and a
      // blank sheet in the middle of the stack is worse than a shorter stack.
      passengerName: { not: null },
    },
    select: { id: true, reference: true, jobType: true, passengerName: true },
    orderBy: { scheduledAt: 'asc' },
    take: 200,
  });

  return jobs.filter(canHaveNameBoard).map((job) => ({
    jobId: job.id,
    reference: job.reference,
    name: normaliseName(job.passengerName),
  }));
}
