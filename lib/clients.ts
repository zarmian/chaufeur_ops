import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import { prisma } from './prisma';
import { emptyToNull, normaliseName, tidy } from './text';
import type { ListParams } from './list-params';

/**
 * Clients — the people who ride.
 *
 * Not the same as an Account, which is the booker and usually who gets
 * invoiced. Keeping them separate is the point: the legacy system had one
 * free-text "Booker" field holding a mix of the operator's own brand, partner
 * agencies and individuals, which made account-level margin unanswerable.
 */

export const clientSchema = z.object({
  name: z.string().trim().min(1, 'Enter the client name').max(200),
  contactPhone: z.string().trim().max(50).optional().or(z.literal('')),
  /**
   * How this client wants to be kept informed — spec 5.10.4.
   *
   * `NONE` is a real choice, not an oversight. A corporate booker whose PA
   * handles everything does not want four texts a day, and defaulting
   * everybody to "both" is how a system gets muted.
   */
  contactChannel: z.enum(['EMAIL', 'SMS', 'BOTH', 'NONE']).default('EMAIL'),
  contactEmail: z
    .string()
    .trim()
    .email('Enter a valid email address')
    .optional()
    .or(z.literal('')),
  billingEmail: z
    .string()
    .trim()
    .email('Enter a valid billing email address')
    .optional()
    .or(z.literal('')),
  billingAddress: z.string().trim().max(500).optional().or(z.literal('')),
  vatNumber: z.string().trim().max(50).optional().or(z.literal('')),
  paymentTermsDays: z.coerce
    .number()
    .int('Payment terms must be a whole number of days')
    .min(0)
    .max(365)
    .default(14),
  // How this client's work is normally taxed. A job may override it, and the
  // booker's answer wins when there is one — the booker gets the invoice.
  vatTreatment: z.enum(['STANDARD', 'INCLUSIVE', 'EXEMPT']).default('STANDARD'),
  defaultAccountId: z.string().trim().optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export type ClientInput = z.infer<typeof clientSchema>;

function toData(input: ClientInput) {
  return {
    name: tidy(input.name),
    normalisedName: normaliseName(input.name),
    contactPhone: emptyToNull(input.contactPhone),
    contactChannel: input.contactChannel,
    contactEmail: emptyToNull(input.contactEmail)?.toLowerCase() ?? null,
    billingEmail: emptyToNull(input.billingEmail)?.toLowerCase() ?? null,
    billingAddress: emptyToNull(input.billingAddress),
    vatNumber: emptyToNull(input.vatNumber),
    paymentTermsDays: input.paymentTermsDays,
    vatTreatment: input.vatTreatment,
    defaultAccountId: emptyToNull(input.defaultAccountId),
    notes: emptyToNull(input.notes),
  };
}

/**
 * Records that would share a normalised name.
 *
 * Surfaced as a warning with a link, never a block — "Mr Williams" and "Mrs
 * Williams" collide by design, and an operator who can see both records is
 * better placed to judge than a rule is.
 */
export async function findPossibleDuplicates(
  name: string,
  excludeId?: string,
): Promise<Array<{ id: string; name: string; contactPhone: string | null }>> {
  const normalised = normaliseName(name);
  if (normalised === '') return [];

  return prisma.client.findMany({
    where: {
      normalisedName: normalised,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, name: true, contactPhone: true },
    take: 5,
  });
}

export interface ClientListFilters {
  archived: boolean;
  accountId: string | null;
}

export async function listClients(
  params: ListParams,
  filters: ClientListFilters,
) {
  const search = params.q;

  const where = {
    // The soft-delete extension hides archived rows by default, so asking for
    // them has to be explicit.
    ...(filters.archived ? { deletedAt: { not: null } } : {}),
    ...(filters.accountId ? { defaultAccountId: filters.accountId } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            {
              normalisedName: {
                contains: normaliseName(search),
                mode: 'insensitive' as const,
              },
            },
            { contactPhone: { contains: search } },
            { contactEmail: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const orderBy =
    params.sort === 'created'
      ? { createdAt: params.dir }
      : { name: params.dir };

  const [rows, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy,
      skip: params.skip,
      take: params.take,
      select: {
        id: true,
        name: true,
        contactPhone: true,
        contactEmail: true,
        paymentTermsDays: true,
        vatTreatment: true,
        deletedAt: true,
        defaultAccount: { select: { id: true, name: true } },
        _count: { select: { jobs: true } },
      },
    }),
    prisma.client.count({ where }),
  ]);

  return { rows, total };
}

export async function getClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    include: {
      defaultAccount: { select: { id: true, name: true } },
    },
  });
}

export async function createClient(
  input: ClientInput,
  context: AuditContext,
): Promise<{ id: string }> {
  return withAudit(
    'Client',
    'create',
    async (tx) => {
      const created = await tx.client.create({ data: toData(input) });
      return { entityId: created.id, after: created, result: { id: created.id } };
    },
    context,
  );
}

export async function updateClient(
  id: string,
  input: ClientInput,
  context: AuditContext,
): Promise<{ id: string }> {
  return withAudit(
    'Client',
    'update',
    async (tx) => {
      const before = await tx.client.findUniqueOrThrow({ where: { id } });
      const after = await tx.client.update({ where: { id }, data: toData(input) });
      return { entityId: id, before, after, result: { id } };
    },
    context,
  );
}

export type ArchiveRefusal = {
  ok: false;
  reason: string;
  openJobs: number;
  unpaidInvoices: number;
};

/**
 * Archive a client, unless doing so would orphan live work.
 *
 * Blocked while non-cancelled jobs or unpaid invoices exist, because a client
 * that vanishes from search while still owing money is how a debt gets
 * forgotten.
 */
export async function archiveClient(
  id: string,
  context: AuditContext,
): Promise<{ ok: true } | ArchiveRefusal> {
  const [openJobs, unpaidInvoices] = await Promise.all([
    prisma.job.count({
      where: { clientId: id, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
    }),
    prisma.invoice.count({
      where: { clientId: id, status: { in: ['DRAFT', 'SENT', 'PART_PAID', 'OVERDUE'] } },
    }),
  ]);

  if (openJobs > 0 || unpaidInvoices > 0) {
    const parts: string[] = [];
    if (openJobs > 0) parts.push(`${openJobs} open job${openJobs === 1 ? '' : 's'}`);
    if (unpaidInvoices > 0) {
      parts.push(
        `${unpaidInvoices} unpaid invoice${unpaidInvoices === 1 ? '' : 's'}`,
      );
    }
    return {
      ok: false,
      reason: `This client still has ${parts.join(' and ')}. Settle or cancel those first.`,
      openJobs,
      unpaidInvoices,
    };
  }

  await withAudit(
    'Client',
    'delete',
    async (tx) => {
      const before = await tx.client.findUniqueOrThrow({ where: { id } });
      await tx.client.update({ where: { id }, data: { deletedAt: new Date() } });
      return { entityId: id, before, result: null };
    },
    context,
  );

  return { ok: true };
}

export async function restoreClient(
  id: string,
  context: AuditContext,
): Promise<void> {
  await withAudit(
    'Client',
    'restore',
    async (tx) => {
      const after = await tx.client.update({
        where: { id, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
      return { entityId: id, after, result: null };
    },
    context,
  );
}
