import type { AuditContext } from './audit';
import { prisma } from './prisma';

/**
 * Turning the addresses people actually type into saved locations — spec
 * 6.4.4.
 *
 * The spec says "bulk-create from the migrated data's most frequent pickup
 * and dropoff strings". There is no migrated data — this install starts empty
 * by design — so the same idea applied to the bookings the business has
 * taken: after a few weeks of use, the twenty addresses typed most often are
 * the twenty worth having on the autocomplete, and nobody is going to enter
 * them by hand.
 *
 * **It proposes; it does not create.** The addresses are free text, so the
 * list contains typos, half-addresses and one-offs alongside the real
 * regulars, and a screen that silently saved all of them would fill the
 * autocomplete with the noise it exists to replace. Somebody ticks the ones
 * that are real.
 */

export interface LocationCandidate {
  /** The address exactly as it was typed. */
  address: string;
  /** How many jobs used it — the reason it is worth saving. */
  uses: number;
  /** The most recent postcode a booking resolved for it, when there is one. */
  postcode: string | null;
  lat: number | null;
  lng: number | null;
}

/** Below this an address is a one-off, not a place the business goes. */
export const MIN_USES = 3;

/**
 * The addresses used most often that are not already saved.
 *
 * Grouped in SQL rather than by loading jobs: this runs over the whole job
 * table, and pulling 50,000 rows into memory to count strings is the shape of
 * thing this system was rebuilt to stop doing.
 *
 * Raw SQL, parameterised, because Prisma's `groupBy` cannot union the pickup
 * and dropoff columns into one tally — and counting them separately would
 * offer the same address twice with two different numbers.
 */
export async function locationCandidates(
  limit = 50,
): Promise<LocationCandidate[]> {
  const rows = await prisma.$queryRaw<
    Array<{ address: string; uses: bigint; postcode: string | null; lat: number | null; lng: number | null }>
  >`
    WITH used AS (
      SELECT "pickupText" AS address, "pickupPostcode" AS postcode,
             "pickupLat" AS lat, "pickupLng" AS lng, "scheduledAt"
      FROM "Job" WHERE "deletedAt" IS NULL AND "pickupText" <> ''
      UNION ALL
      SELECT "dropoffText", "dropoffPostcode", "dropoffLat", "dropoffLng", "scheduledAt"
      FROM "Job" WHERE "deletedAt" IS NULL AND "dropoffText" <> ''
    ),
    ranked AS (
      SELECT address, postcode, lat, lng,
             ROW_NUMBER() OVER (
               PARTITION BY lower(btrim(address))
               -- The most recent resolved postcode wins: an address typed by
               -- hand early and looked up properly later should carry the
               -- lookup's answer, not the blank.
               ORDER BY (postcode IS NULL), "scheduledAt" DESC
             ) AS rn,
             COUNT(*) OVER (PARTITION BY lower(btrim(address))) AS uses
      FROM used
    )
    SELECT address, uses, postcode, lat, lng
    FROM ranked
    WHERE rn = 1
      AND uses >= ${MIN_USES}
      AND lower(btrim(address)) NOT IN (
        SELECT lower(btrim(label)) FROM "Location" WHERE "deletedAt" IS NULL
        UNION
        SELECT lower(btrim(address)) FROM "Location" WHERE "deletedAt" IS NULL
      )
    ORDER BY uses DESC, address ASC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    address: row.address,
    uses: Number(row.uses),
    postcode: row.postcode,
    lat: row.lat,
    lng: row.lng,
  }));
}

export interface SaveCandidatesResult {
  created: number;
  skipped: string[];
}

/**
 * Save the chosen candidates as locations — spec 6.4.4.
 *
 * `useCount` starts at the number of bookings that already used the address,
 * so a location created this way sorts where it belongs immediately rather
 * than sitting at the bottom of the autocomplete until it is chosen again.
 *
 * One already saved by somebody else in the meantime is skipped and named,
 * not treated as a failure — two people tidying the same list is normal.
 */
export async function saveCandidates(
  addresses: string[],
  _context: AuditContext,
): Promise<SaveCandidatesResult> {
  if (addresses.length === 0) return { created: 0, skipped: [] };

  const candidates = await locationCandidates(500);
  const byAddress = new Map(
    candidates.map((candidate) => [candidate.address.trim().toLowerCase(), candidate]),
  );

  const skipped: string[] = [];
  let created = 0;

  for (const address of addresses) {
    const candidate = byAddress.get(address.trim().toLowerCase());
    if (!candidate) {
      skipped.push(address);
      continue;
    }

    await prisma.location.create({
      data: {
        label: candidate.address.slice(0, 120),
        address: candidate.address,
        postcode: candidate.postcode,
        lat: candidate.lat,
        lng: candidate.lng,
        // The bookings that already went here.
        useCount: candidate.uses,
      },
    });
    created += 1;
  }

  return { created, skipped };
}
