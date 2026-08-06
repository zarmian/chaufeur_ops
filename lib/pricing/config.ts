import type { JobType, VehicleClass } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { withAudit, type AuditContext } from '../audit';
import { fromDateOnlyString } from '../dates';
import { prisma } from '../prisma';
import { ruleProblems } from './resolve';
import {
  checked,
  parsePostcodes,
  penceFrom,
  type LocationInput,
  type RateCardInput,
  type RateRuleInput,
  type ZoneInput,
} from './schema';

/**
 * Zones, rate cards, rules and locations — the configuration behind pricing.
 *
 * Rate cards are audited (`AuditEntity` already names them): a fare that
 * changed and nobody can say when or by whom is the legacy problem this
 * system exists to end, and a rate card is where fares actually live.
 *
 * Refusals come back as values rather than exceptions, in the same shape the
 * invoice store uses, because most of them are rules rather than faults —
 * "this card is in use, end-date it instead" is something to show an operator,
 * not something to log.
 */

export type ConfigResult =
  | { ok: true; id: string }
  | { ok: false; code: string; message: string };

// ------------------------------------------------------------------- zones

export async function listZones() {
  return prisma.zone.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { rulesFromZone: true, rulesToZone: true, locations: true } } },
  });
}

export async function saveZone(
  id: string | null,
  input: ZoneInput,
): Promise<ConfigResult> {
  const data = {
    name: input.name.trim(),
    postcodes: parsePostcodes(input.postcodes),
    active: checked(input.active),
  };

  // Two active zones claiming the same prefix make the match arbitrary:
  // `zoneForPostcode` takes the longest prefix and has nothing left to break
  // a tie with, so the same postcode prices differently depending on row
  // order. Refused here rather than resolved silently, because which of the
  // two the operator meant is not something this can work out.
  if (data.active && data.postcodes.length > 0) {
    const clash = await claimedPrefix(id, data.postcodes);
    if (clash) {
      return {
        ok: false,
        code: 'PREFIX_CLAIMED',
        message: `${clash.prefix} is already claimed by ${clash.zoneName}. A postcode that two active zones both claim would price differently depending on which was read first — remove it from one of them.`,
      };
    }
  }

  try {
    const zone = id
      ? await prisma.zone.update({ where: { id }, data })
      : await prisma.zone.create({ data });
    return { ok: true, id: zone.id };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return {
        ok: false,
        code: 'DUPLICATE_ZONE',
        message: `There is already a zone called ${data.name}.`,
      };
    }
    throw error;
  }
}

/**
 * Whether another active zone already claims one of these prefixes.
 *
 * Exact matches only. `TW` and `TW6` are a deliberate pair — the longest
 * prefix wins and that is the whole point — so nesting is allowed and only a
 * genuine duplicate is refused.
 */
async function claimedPrefix(
  id: string | null,
  postcodes: string[],
): Promise<{ prefix: string; zoneName: string } | null> {
  const others = await prisma.zone.findMany({
    where: { active: true, ...(id ? { id: { not: id } } : {}) },
    select: { name: true, postcodes: true },
  });

  for (const other of others) {
    for (const prefix of other.postcodes) {
      if (postcodes.includes(prefix)) {
        return { prefix, zoneName: other.name };
      }
    }
  }

  return null;
}

/**
 * Zones are deactivated, never deleted.
 *
 * A rule points at one, and so does every location in it. Removing the row
 * would either fail on the foreign key or orphan the rules that priced last
 * month's jobs — and those have to stay readable.
 */
export async function deactivateZone(id: string): Promise<ConfigResult> {
  const zone = await prisma.zone.update({
    where: { id },
    data: { active: false },
  });
  return { ok: true, id: zone.id };
}

// -------------------------------------------------------------- rate cards

export async function listRateCards() {
  return prisma.rateCard.findMany({
    orderBy: [{ isDefault: 'desc' }, { activeFrom: 'desc' }],
    include: { _count: { select: { rules: true, accounts: true } } },
  });
}

export async function getRateCard(id: string) {
  return prisma.rateCard.findUnique({
    where: { id },
    include: {
      accounts: { select: { id: true, name: true } },
      rules: {
        orderBy: [{ jobType: 'asc' }, { priority: 'desc' }],
        include: {
          fromZone: { select: { id: true, name: true } },
          toZone: { select: { id: true, name: true } },
          _count: { select: { jobs: true } },
        },
      },
    },
  });
}

export async function saveRateCard(
  id: string | null,
  input: RateCardInput,
  context: AuditContext,
): Promise<ConfigResult> {
  const data = {
    name: input.name.trim(),
    activeFrom: fromDateOnlyString(input.activeFrom),
    activeTo: input.activeTo ? fromDateOnlyString(input.activeTo) : null,
    isDefault: checked(input.isDefault),
  };

  const card = await withAudit(
    'RateCard',
    id ? 'update' : 'create',
    async (tx) => {
      // One default at a time. Two would make "which card prices this job"
      // depend on insertion order, which is not an answer anyone can act on.
      if (data.isDefault) {
        await tx.rateCard.updateMany({
          where: { isDefault: true, ...(id ? { id: { not: id } } : {}) },
          data: { isDefault: false },
        });
      }

      const before = id
        ? await tx.rateCard.findUnique({ where: { id } })
        : undefined;
      const after = id
        ? await tx.rateCard.update({ where: { id }, data })
        : await tx.rateCard.create({ data });

      return { entityId: after.id, before, after, result: after };
    },
    context,
  );

  return { ok: true, id: card.id };
}

/**
 * A card in use is end-dated, not deleted — spec 4.2.10.
 *
 * "In use" means an account points at it or a job was priced from one of its
 * rules. Either way the card is part of the record of what something cost,
 * and deleting it would leave a job whose price nothing explains.
 */
export async function retireRateCard(
  id: string,
  context: AuditContext,
): Promise<ConfigResult> {
  const card = await prisma.rateCard.findUnique({
    where: { id },
    include: {
      _count: { select: { accounts: true } },
      rules: { select: { _count: { select: { jobs: true } } } },
    },
  });

  if (!card) return { ok: false, code: 'NOT_FOUND', message: 'No such rate card' };

  const pricedJobs = card.rules.reduce((total, rule) => total + rule._count.jobs, 0);
  const inUse = card._count.accounts > 0 || pricedJobs > 0;
  const today = new Date();

  await withAudit(
    'RateCard',
    inUse ? 'update' : 'delete',
    async (tx) => {
      const before = await tx.rateCard.findUniqueOrThrow({ where: { id } });
      const after = inUse
        ? await tx.rateCard.update({
            where: { id },
            data: { activeTo: today, isDefault: false },
          })
        : await tx.rateCard.update({
            where: { id },
            data: { deletedAt: today, isDefault: false },
          });
      return { entityId: id, before, after, result: null };
    },
    context,
  );

  return inUse
    ? {
        ok: false,
        code: 'IN_USE',
        message: `${card.name} has priced ${pricedJobs} job${pricedJobs === 1 ? '' : 's'} or is attached to an account, so it has been end-dated today rather than removed. Past jobs keep the price it gave them.`,
      }
    : { ok: true, id };
}

// ------------------------------------------------------------------- rules

export async function saveRateRule(
  cardId: string,
  ruleId: string | null,
  input: RateRuleInput,
  context: AuditContext,
): Promise<ConfigResult> {
  const data = {
    rateCardId: cardId,
    jobType: input.jobType as JobType,
    vehicleClass: (input.vehicleClass as VehicleClass | null) ?? null,
    fromZoneId: input.fromZoneId,
    toZoneId: input.toZoneId,

    baseFarePence: penceFrom(input.baseFare),
    perHourPence: penceFrom(input.perHour),
    minimumHours:
      input.minimumHours === null ? null : new Prisma.Decimal(input.minimumHours),
    freeWaitMinutes: input.freeWaitMinutes,
    waitPerMinutePence: penceFrom(input.waitPerMinute),

    driverBasePence: penceFrom(input.driverBase),
    driverPerHourPence: penceFrom(input.driverPerHour),
    driverPctOfFare:
      input.driverPctOfFare === null
        ? null
        : new Prisma.Decimal(input.driverPctOfFare),

    priority: input.priority,
  };

  // 4.2.5 — the cross-field rules, checked against the numbers that are about
  // to be stored rather than the text that was typed.
  const problems = ruleProblems({
    baseFarePence: data.baseFarePence,
    perHourPence: data.perHourPence,
    minimumHours: input.minimumHours,
    driverBasePence: data.driverBasePence,
    driverPerHourPence: data.driverPerHourPence,
    driverPctOfFare: input.driverPctOfFare,
  });

  if (problems.length > 0) {
    return { ok: false, code: 'INVALID_RULE', message: problems.join(' ') };
  }

  const rule = await withAudit(
    'RateCard',
    ruleId ? 'update' : 'create',
    async (tx) => {
      const before = ruleId
        ? await tx.rateCardRule.findUnique({ where: { id: ruleId } })
        : undefined;
      const after = ruleId
        ? await tx.rateCardRule.update({ where: { id: ruleId }, data })
        : await tx.rateCardRule.create({ data });

      // The audit entry is about the card: that is the thing an operator
      // looks up when a price changed, and a rule id on its own means
      // nothing to them.
      return { entityId: cardId, before, after, result: after };
    },
    context,
  );

  return { ok: true, id: rule.id };
}

/**
 * Remove a rule.
 *
 * A rule that has priced a job cannot go: `Job.rateCardRuleId` points at it,
 * and that link is how a price is explained months later.
 */
export async function deleteRateRule(
  cardId: string,
  ruleId: string,
  context: AuditContext,
): Promise<ConfigResult> {
  const rule = await prisma.rateCardRule.findUnique({
    where: { id: ruleId },
    include: { _count: { select: { jobs: true } } },
  });

  if (!rule) return { ok: false, code: 'NOT_FOUND', message: 'No such rule' };

  if (rule._count.jobs > 0) {
    return {
      ok: false,
      code: 'RULE_IN_USE',
      message: `This rule priced ${rule._count.jobs} job${rule._count.jobs === 1 ? '' : 's'}, and that link is how those prices are explained later. Change its amounts, or end-date the whole card.`,
    };
  }

  await withAudit(
    'RateCard',
    'delete',
    async (tx) => {
      const before = await tx.rateCardRule.findUniqueOrThrow({
        where: { id: ruleId },
      });
      await tx.rateCardRule.delete({ where: { id: ruleId } });
      return { entityId: cardId, before, result: null };
    },
    context,
  );

  return { ok: true, id: ruleId };
}

// --------------------------------------------------------------- locations

export async function listLocations(query: string | null, take = 50) {
  return prisma.location.findMany({
    where: query
      ? {
          OR: [
            { label: { contains: query, mode: 'insensitive' } },
            { address: { contains: query, mode: 'insensitive' } },
            { postcode: { contains: query, mode: 'insensitive' } },
          ],
        }
      : {},
    // Spec 4.1.5 — ordered by how often it has actually been used, so the
    // places this operator books to are the ones they see first.
    orderBy: [{ useCount: 'desc' }, { label: 'asc' }],
    take,
    include: { zone: { select: { id: true, name: true } } },
  });
}

export async function saveLocation(
  id: string | null,
  input: LocationInput,
): Promise<ConfigResult> {
  const data = {
    label: input.label.trim(),
    address: input.address.trim(),
    postcode: input.postcode?.trim().toUpperCase() || null,
    zoneId: input.zoneId,
    isAirport: checked(input.isAirport),
  };

  const location = id
    ? await prisma.location.update({ where: { id }, data })
    : await prisma.location.create({ data });

  return { ok: true, id: location.id };
}

export async function deleteLocation(id: string): Promise<ConfigResult> {
  await prisma.location.update({ where: { id }, data: { deletedAt: new Date() } });
  return { ok: true, id };
}

/**
 * Note that a saved location was chosen — spec 4.1.6.
 *
 * Matched on the text rather than an id, because the booking form's pickup
 * and destination are free-text fields backed by a datalist: the operator
 * picks a suggestion and the browser puts its *label* in the box, with no id
 * anywhere. Counting only jobs that carried a location id would leave the
 * count at zero forever and the autocomplete ordered by nothing.
 *
 * Best-effort throughout: the count drives suggestion ordering, and losing an
 * increment matters far less than failing a booking over it.
 */
export async function noteLocationUse(
  texts: Array<string | null | undefined>,
): Promise<void> {
  const wanted = [
    ...new Set(
      texts
        .map((text) => text?.trim())
        .filter((text): text is string => Boolean(text)),
    ),
  ];
  if (wanted.length === 0) return;

  try {
    const matches = await prisma.location.findMany({
      where: {
        OR: wanted.flatMap((text) => [
          { label: { equals: text, mode: 'insensitive' as const } },
          { address: { equals: text, mode: 'insensitive' as const } },
        ]),
      },
      select: { id: true },
    });

    if (matches.length === 0) return;

    await prisma.location.updateMany({
      where: { id: { in: matches.map((match) => match.id) } },
      data: { useCount: { increment: 1 } },
    });
  } catch {
    // Nothing to do.
  }
}
