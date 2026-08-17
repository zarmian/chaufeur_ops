/**
 * Asking whether a driver is already busy, from the browser.
 *
 * Client-safe by construction: this module imports nothing, so the booking
 * form can use it without dragging Prisma into the bundle. Same shape as
 * `lib/pricing/quote-client.ts`, and for the same reason.
 */

export interface ConflictQuery {
  jobId?: string | null;
  driverId?: string | null;
  vehicleId?: string | null;
  scheduledDate: string;
  scheduledTime: string;
  estimatedMinutes?: number | null;
  hours?: number | null;
  /** The last day of a contract, which holds the driver for the whole block. */
  contractEndsOn?: string | null;
}

export interface ConflictNote {
  id: string;
  reference: string;
  overlapping: boolean;
}

export interface ConflictAnswer {
  warnings: string[];
  conflicts: ConflictNote[];
}

const NOTHING: ConflictAnswer = { warnings: [], conflicts: [] };

/**
 * Everything the check needs before it is worth asking.
 *
 * Without somebody to clash with and a time to clash at there is nothing to
 * compare, and a request per keystroke into an empty form is noise.
 */
export function conflictIsWorthAsking(input: Partial<ConflictQuery>): boolean {
  return Boolean(
    (input.driverId || input.vehicleId) &&
      input.scheduledDate &&
      input.scheduledTime,
  );
}

/**
 * The answer, or nothing.
 *
 * Nothing covers both "no clash" and "the request failed". Neither is an
 * error the operator needs to see: the booking is happening either way, and a
 * missing warning is a warning they would have been free to ignore.
 */
export async function fetchConflicts(
  input: ConflictQuery,
  signal?: AbortSignal,
): Promise<ConflictAnswer> {
  try {
    const response = await fetch('/api/jobs/conflicts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });

    if (!response.ok) return NOTHING;

    const body = (await response.json()) as Partial<ConflictAnswer>;
    return {
      warnings: body.warnings ?? [],
      conflicts: body.conflicts ?? [],
    };
  } catch {
    return NOTHING;
  }
}
