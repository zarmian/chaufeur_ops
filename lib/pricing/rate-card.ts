import type { JobType, VehicleClass } from '@prisma/client';
import { prisma } from '../prisma';
import {
  priceFromRule,
  resolveRule,
  type RateRule,
  type RateQuery as ResolveQuery,
} from './resolve';
import { resolveZone, type ZoneRecord } from './zones';

/**
 * Rate card resolution — the suggested price for a booking.
 *
 * The matching and the arithmetic live in `./resolve.ts`, which is pure. This
 * module fetches the right card and turns free-text pickup and dropoff into
 * zones.
 *
 * Three things carried over from the Phase 2 stub this replaces, all of which
 * must stay true:
 *
 * - **Returning null is a first-class answer.** Most bookings will never
 *   match a rule, and the form treats no suggestion as normal rather than as
 *   an error.
 * - **A suggestion never becomes the saved price by itself.** It pre-fills a
 *   field the operator can overwrite, and what they leave in the field is
 *   what gets stored. The price is a commercial agreement, not a calculation.
 * - **It never throws.** A pricing lookup that fails must not stop a booking
 *   being taken; the phone call is happening either way.
 */

export interface RateQuery {
  jobType: JobType;
  vehicleClass?: VehicleClass | null;
  accountId?: string | null;
  clientId?: string | null;
  /** Free text, as typed. Resolved to zones here. */
  pickupText?: string | null;
  dropoffText?: string | null;
  pickupPostcode?: string | null;
  dropoffPostcode?: string | null;
  /** Already-resolved zones, when the caller knows them. */
  fromZoneId?: string | null;
  toZoneId?: string | null;
  /** For `AS_DIRECTED`, the hours being booked. */
  hours?: number | null;
  /** For `CONTRACT`, the days being booked. */
  days?: number | null;
  waitMinutes?: number | null;
  scheduledAt: Date;
}

export interface RateSuggestion {
  /** The rule this came from, stored on the job for later reconciliation. */
  rateCardRuleId: string;
  clientPricePence: number;
  driverPricePence: number | null;
  freeWaitMinutes: number;
  /** Shown next to the field so the operator knows why it says what it says. */
  explanation: string;
  fromZoneName: string | null;
  toZoneName: string | null;
}

/**
 * The card that applies to this booking.
 *
 * An account may carry its own, overriding the default (spec 4.2.9). Dates
 * are checked against the *job's* date rather than today: a booking taken in
 * March for a job in April is priced on April's card.
 */
export async function cardForQuery(query: RateQuery) {
  const at = query.scheduledAt;

  if (query.accountId) {
    const account = await prisma.account.findUnique({
      where: { id: query.accountId },
      select: {
        rateCard: {
          select: { id: true, name: true, activeFrom: true, activeTo: true },
        },
      },
    });
    const own = account?.rateCard;
    if (own && isActiveAt(own, at)) return own;
  }

  return prisma.rateCard.findFirst({
    where: {
      isDefault: true,
      activeFrom: { lte: at },
      OR: [{ activeTo: null }, { activeTo: { gte: at } }],
    },
    select: { id: true, name: true, activeFrom: true, activeTo: true },
    orderBy: { activeFrom: 'desc' },
  });
}

function isActiveAt(
  card: { activeFrom: Date; activeTo: Date | null },
  at: Date,
): boolean {
  if (card.activeFrom > at) return false;
  return card.activeTo === null || card.activeTo >= at;
}

/** Every active zone, for the matcher. Small and rarely changing. */
export async function loadZones(): Promise<ZoneRecord[]> {
  return prisma.zone.findMany({
    where: { active: true },
    select: { id: true, name: true, postcodes: true },
  });
}

export async function suggestPrice(
  query: RateQuery,
): Promise<RateSuggestion | null> {
  try {
    const card = await cardForQuery(query);
    if (!card) return null;

    const zones = await loadZones();

    const from =
      query.fromZoneId != null
        ? { zoneId: query.fromZoneId, zoneName: zoneName(zones, query.fromZoneId) }
        : matchZone(query.pickupText, query.pickupPostcode, zones);

    const to =
      query.toZoneId != null
        ? { zoneId: query.toZoneId, zoneName: zoneName(zones, query.toZoneId) }
        : matchZone(query.dropoffText, query.dropoffPostcode, zones);

    const rules = await prisma.rateCardRule.findMany({
      where: { rateCardId: card.id, jobType: query.jobType },
    });

    const resolveQuery: ResolveQuery = {
      jobType: query.jobType,
      vehicleClass: query.vehicleClass ?? null,
      fromZoneId: from?.zoneId ?? null,
      toZoneId: to?.zoneId ?? null,
      hours: query.hours ?? null,
      days: query.days ?? null,
      waitMinutes: query.waitMinutes ?? null,
    };

    const rule = resolveRule(rules.map(toRateRule), resolveQuery);
    if (!rule) {
      await recordUnmatched(query);
      return null;
    }

    const priced = priceFromRule(rule, resolveQuery);

    // A rule that prices at nothing is a misconfiguration, not a free job.
    // Offering £0.00 as a suggestion is how an unpriced job gets created on
    // purpose — the very thing the money-is-never-silently-zero rule exists
    // to prevent.
    if (priced.clientPricePence <= 0) return null;

    return {
      rateCardRuleId: priced.ruleId,
      clientPricePence: priced.clientPricePence,
      driverPricePence: priced.driverPricePence,
      freeWaitMinutes: priced.freeWaitMinutes,
      explanation: `${card.name}: ${priced.explanation}`,
      fromZoneName: from?.zoneName ?? null,
      toZoneName: to?.zoneName ?? null,
    };
  } catch {
    // A misconfigured rate card must not stop a booking being taken.
    return null;
  }
}

function zoneName(zones: ZoneRecord[], id: string): string | null {
  return zones.find((zone) => zone.id === id)?.name ?? null;
}

function matchZone(
  text: string | null | undefined,
  postcode: string | null | undefined,
  zones: ZoneRecord[],
): { zoneId: string; zoneName: string } | null {
  if (!text && !postcode) return null;
  const match = resolveZone(text ?? '', zones, postcode);
  return match ? { zoneId: match.zoneId, zoneName: match.zoneName } : null;
}

const UNMATCHED_PREFIX = 'pricing.unmatched.';

/**
 * Note a booking nothing priced.
 *
 * Spec 4.1.7. The list of things the matcher fails on *is* the specification
 * for improving it — without it, the only signal that pricing is not working
 * is an operator who has quietly gone back to typing every price by hand.
 *
 * Keyed on the normalised pickup text so the same address does not accumulate
 * a row per booking, and best-effort throughout: losing a diagnostic is not
 * worth failing a booking over.
 */
async function recordUnmatched(query: RateQuery): Promise<void> {
  const pickup = query.pickupText?.trim();
  if (!pickup) return;

  const value = {
    pickupText: pickup.slice(0, 200),
    dropoffText: query.dropoffText?.trim().slice(0, 200) ?? null,
    jobType: query.jobType,
    lastSeenAt: new Date().toISOString(),
  };

  try {
    await prisma.setting.upsert({
      where: { key: `${UNMATCHED_PREFIX}${hashKey(pickup)}` },
      update: { value },
      create: { key: `${UNMATCHED_PREFIX}${hashKey(pickup)}`, value },
    });
  } catch {
    // Nothing to do.
  }
}

/** A short, stable key so the same pickup text maps to the same row. */
function hashKey(input: string): string {
  let hash = 0;
  const normalised = input.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (let index = 0; index < normalised.length; index += 1) {
    hash = (hash * 31 + normalised.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export interface UnmatchedPickup {
  pickupText: string;
  dropoffText: string | null;
  jobType: string;
  lastSeenAt: string | null;
}

/** The pickup strings nothing priced, most recent first. */
export async function unmatchedPickups(limit = 100): Promise<UnmatchedPickup[]> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: UNMATCHED_PREFIX } },
    take: limit,
  });

  return rows
    .map((row) => row.value as Record<string, unknown>)
    .filter((value) => typeof value?.pickupText === 'string')
    .map((value) => ({
      pickupText: String(value.pickupText),
      dropoffText:
        typeof value.dropoffText === 'string' ? value.dropoffText : null,
      jobType: String(value.jobType ?? ''),
      lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : null,
    }))
    .sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''));
}

/** Forget one, once the matcher has been taught about it. */
export async function clearUnmatched(pickupText: string): Promise<void> {
  await prisma.setting.deleteMany({
    where: { key: `${UNMATCHED_PREFIX}${hashKey(pickupText.trim())}` },
  });
}

/** Prisma's `Decimal` columns arrive as objects; the matcher wants numbers. */
function toRateRule(row: {
  id: string;
  jobType: JobType;
  vehicleClass: VehicleClass | null;
  fromZoneId: string | null;
  toZoneId: string | null;
  baseFarePence: number;
  perHourPence: number;
  minimumHours: unknown;
  perDayPence: number;
  minimumDays: unknown;
  freeWaitMinutes: number;
  waitPerMinutePence: number;
  driverBasePence: number;
  driverPerHourPence: number;
  driverPctOfFare: unknown;
  priority: number;
}): RateRule {
  return {
    id: row.id,
    jobType: row.jobType,
    vehicleClass: row.vehicleClass,
    fromZoneId: row.fromZoneId,
    toZoneId: row.toZoneId,
    baseFarePence: row.baseFarePence,
    perHourPence: row.perHourPence,
    minimumHours: toNumber(row.minimumHours),
    perDayPence: row.perDayPence,
    minimumDays: toNumber(row.minimumDays),
    freeWaitMinutes: row.freeWaitMinutes,
    waitPerMinutePence: row.waitPerMinutePence,
    driverBasePence: row.driverBasePence,
    driverPerHourPence: row.driverPerHourPence,
    driverPctOfFare: toNumber(row.driverPctOfFare),
    priority: row.priority,
  };
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : null;
}

/**
 * Whether this job type is priced by the hour.
 *
 * `AS_DIRECTED` is hourly with a minimum-hours rule; `TRANSFER` and
 * `AIRPORT_TRANSFER` are fixed-fare. The form uses this to decide whether to
 * ask for hours.
 */
export function isHourlyJobType(jobType: JobType): boolean {
  return jobType === 'AS_DIRECTED';
}
