import { z } from 'zod';
import { withAudit, type AuditContext } from './audit';
import { toUTC } from './dates';
import { parseMoney } from './money';
import { prisma } from './prisma';
import { formatReference } from './references';
import {
  DEFAULT_CHECKLIST_ITEMS,
  findRentalOverlap,
  rentalBalance,
  RENTAL_REFERENCE_PAD,
  RENTAL_REFERENCE_PREFIX,
  type RentalRefusal,
} from './rentals';
import { emptyToNull } from './text';

/**
 * Persistence for rentals. The charging rules live in `lib/rentals.ts`.
 *
 * Rentals are audited as `Vehicle` changes: the asset is the thing whose
 * history someone will want to reconstruct — where was this car in March, and
 * who had it.
 */

const money = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? '0' : value))
  .superRefine((value, ctx) => {
    try {
      if (parseMoney(value) < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That cannot be negative' });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount like 80.00' });
    }
  })
  .transform((value) => parseMoney(value));

/**
 * Money that may simply not have been agreed.
 *
 * Distinct from `money`, which treats a blank as zero. On a contract the two
 * are opposites: an unset excess fee must print as a line to write on, and
 * "£0.00" would state that the hirer owes nothing in the event of a claim.
 */
const optionalMoney = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      try {
        if (parseMoney(value) < 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That cannot be negative' });
        }
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount like 80.00' });
      }
    })
    .transform((value) => parseMoney(value))
    .nullable(),
);

const optionalInt = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.coerce.number().int().min(0).nullable(),
);

export const rentalSchema = z
  .object({
    vehicleId: z.string().trim().min(1, 'Choose a vehicle'),
    renterType: z.enum(['DRIVER', 'ACCOUNT', 'EXTERNAL']).default('DRIVER'),
    driverId: z.string().trim().optional().or(z.literal('')),
    accountId: z.string().trim().optional().or(z.literal('')),
    hirerName: z.string().trim().max(200).optional().or(z.literal('')),
    hirerAddress: z.string().trim().max(500).optional().or(z.literal('')),
    hirerPhone: z.string().trim().max(40).optional().or(z.literal('')),
    hirerLicenceNumber: z.string().trim().max(40).optional().or(z.literal('')),
    /** Saves a one-off hirer as an account, so a repeat customer is picked next time. */
    saveHirerAsAccount: z.coerce.boolean().default(false),
    startAt: z.string().trim().min(1, 'Enter when it goes out'),
    endAt: z.string().trim().min(1, 'Enter when it is due back'),
    rateType: z.enum(['HOURLY', 'DAILY', 'WEEKLY']),
    ratePence: money,
    depositPence: money,
    mileageOut: optionalInt,
    fuelOutPct: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? null : value),
      z.coerce.number().int().min(0).max(100).nullable(),
    ),
    notes: z.string().trim().max(2000).optional().or(z.literal('')),

    // What this contract says. Defaults come from the form; what is stored is
    // what was agreed, so reprinting it later cannot restate today's rates.
    mileageAllowancePerDay: optionalInt,
    excessMileagePence: optionalMoney,
    advancePaymentPence: money,
    minimumTermDays: optionalInt,
    insuranceExcessPence: optionalMoney,
    congestionChargePence: optionalMoney,
    smokingChargePence: optionalMoney,
    panelRepairPence: optionalMoney,
    wheelScratchPence: optionalMoney,
    depositReturnDays: optionalInt,
    ownerSignatory: z.string().trim().max(200).optional().or(z.literal('')),
  })
  .superRefine((input, ctx) => {
    // Whichever kind of renter was chosen has to actually be identified.
    if (input.renterType === 'DRIVER' && !input.driverId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['driverId'],
        message: 'Choose the driver renting it',
      });
    }
    if (input.renterType === 'ACCOUNT' && !input.accountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountId'],
        message: 'Choose the company renting it',
      });
    }
    if (input.renterType === 'EXTERNAL' && !input.hirerName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hirerName'],
        // A hire agreement with no named hirer is not a contract.
        message: 'A hirer who is not on the system still needs a name for the contract',
      });
    }
    if (new Date(input.endAt).getTime() <= new Date(input.startAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endAt'],
        message: 'The return must be after the collection',
      });
    }
    if (input.ratePence <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ratePence'],
        message: 'Enter the rate — a rental with no rate earns nothing',
      });
    }
  });

export type RentalInput = z.infer<typeof rentalSchema>;

async function nextRentalReference(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING(reference FROM ${`^${RENTAL_REFERENCE_PREFIX}-(\\d+)$`}) AS INTEGER)) AS max
    FROM "VehicleRental"
    WHERE reference ~ ${`^${RENTAL_REFERENCE_PREFIX}-\\d+$`}
  `;
  return formatReference(
    RENTAL_REFERENCE_PREFIX,
    (rows[0]?.max ?? 0) + 1,
    RENTAL_REFERENCE_PAD,
  );
}

/**
 * Book a rental.
 *
 * Refuses a car already spoken for in that period. Double-booking a physical
 * asset is not something to warn about and allow — there is only one car.
 */
export async function createRental(
  input: RentalInput,
  context: AuditContext,
): Promise<{ ok: true; id: string; reference: string } | (RentalRefusal & { ok: false })> {
  const startAt = toUTC(input.startAt);
  const endAt = toUTC(input.endAt);

  const existing = await prisma.vehicleRental.findMany({
    where: { vehicleId: input.vehicleId, status: { not: 'CANCELLED' } },
    select: {
      id: true,
      reference: true,
      startAt: true,
      endAt: true,
      returnedAt: true,
      status: true,
    },
  });

  const clash = findRentalOverlap({ startAt, endAt }, existing);
  if (clash) {
    return {
      ok: false,
      message: `That vehicle is already on rental ${clash.reference} for part of this period`,
      rentalReference: clash.reference,
    };
  }

  const reference = await nextRentalReference();

  // A one-off hirer becomes an account, so the second time they hire the car
  // they are picked from a list rather than retyped — and a repeat customer
  // spelled two ways is two customers.
  let accountId = input.accountId || null;
  if (input.renterType === 'EXTERNAL' && input.saveHirerAsAccount && input.hirerName) {
    const existingAccount = await prisma.account.findFirst({
      where: { name: input.hirerName },
      select: { id: true },
    });
    accountId =
      existingAccount?.id ??
      (
        await prisma.account.create({
          data: {
            name: input.hirerName,
            kind: 'INDIVIDUAL',
            contactPhone: input.hirerPhone || null,
            billingAddress: input.hirerAddress || null,
          },
          select: { id: true },
        })
      ).id;
  }

  return withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const created = await tx.vehicleRental.create({
        data: {
          reference,
          vehicleId: input.vehicleId,
          renterType: input.renterType,
          // Only the driver named for a driver hire; a company or one-off
          // hire leaves it null rather than pointing at somebody unrelated.
          driverId: input.renterType === 'DRIVER' ? input.driverId || null : null,
          accountId,
          hirerName: input.hirerName || null,
          hirerAddress: input.hirerAddress || null,
          hirerPhone: input.hirerPhone || null,
          hirerLicenceNumber: input.hirerLicenceNumber || null,
          startAt,
          endAt,
          rateType: input.rateType,
          ratePence: input.ratePence,
          depositPence: input.depositPence,
          mileageOut: input.mileageOut,
          fuelOutPct: input.fuelOutPct,
          mileageAllowancePerDay: input.mileageAllowancePerDay,
          excessMileagePence: input.excessMileagePence,
          advancePaymentPence: input.advancePaymentPence,
          minimumTermDays: input.minimumTermDays,
          insuranceExcessPence: input.insuranceExcessPence,
          congestionChargePence: input.congestionChargePence,
          smokingChargePence: input.smokingChargePence,
          panelRepairPence: input.panelRepairPence,
          wheelScratchPence: input.wheelScratchPence,
          depositReturnDays: input.depositReturnDays,
          ownerSignatory: input.ownerSignatory || null,
          notes: emptyToNull(input.notes),
          createdById: context.userId ?? null,
        },
      });

      // The collection checklist is written now, so the handover has
      // something to fill in rather than someone having to remember the list.
      await tx.rentalChecklistItem.createMany({
        data: DEFAULT_CHECKLIST_ITEMS.map((label) => ({
          rentalId: created.id,
          phase: 'OUT' as const,
          label,
        })),
      });

      return {
        entityId: created.vehicleId,
        after: created,
        result: { ok: true as const, id: created.id, reference: created.reference },
      };
    },
    context,
  );
}

/**
 * Whether a hire may still be changed, and why not.
 *
 * One rule, checked in the same place for editing, cancelling and deleting: a
 * hire that has been billed is a figure on a document somebody else is
 * holding. Changing the rate underneath it leaves the invoice and the hire
 * disagreeing with nothing to say which is right — the same reason a sent
 * invoice is corrected with a credit note rather than an edit.
 *
 * Deliberately *not* a status check. A returned hire is finished, not
 * immutable: correcting a mistyped mileage or rate afterwards is ordinary
 * work, and refusing it would push somebody back to the database.
 */
export async function rentalEditability(
  rentalId: string,
): Promise<RentalRefusal> {
  const billed = await prisma.invoiceLine.findFirst({
    where: { rentalId, invoice: { status: { not: 'CANCELLED' } } },
    select: { invoice: { select: { number: true, status: true } } },
  });

  if (billed) {
    return {
      ok: false,
      message: `This hire is on invoice ${billed.invoice.number}. Credit that invoice first — changing the hire underneath it would leave the two disagreeing.`,
    };
  }

  return { ok: true };
}

/**
 * Change a hire that has already been booked.
 *
 * The overlap check runs again, excluding this hire from its own comparison —
 * otherwise every edit would report the car as clashing with itself, perfectly.
 * Moving a hire onto a car or a period somebody else has is still refused:
 * there is only one car, and that is not a warning.
 *
 * The return readings are not touched. They belong to `returnRental`, which is
 * where somebody stood at the car and wrote them down.
 */
export async function updateRental(
  rentalId: string,
  input: RentalInput,
  context: AuditContext,
): Promise<{ ok: true; id: string } | (RentalRefusal & { ok: false })> {
  const rental = await prisma.vehicleRental.findUnique({
    where: { id: rentalId },
    select: { id: true, vehicleId: true, status: true, accountId: true },
  });
  if (!rental) return { ok: false, message: 'That hire no longer exists' };

  const editable = await rentalEditability(rentalId);
  if (!editable.ok) return editable;

  const startAt = toUTC(input.startAt);
  const endAt = toUTC(input.endAt);

  const existing = await prisma.vehicleRental.findMany({
    where: {
      vehicleId: input.vehicleId,
      status: { not: 'CANCELLED' },
      id: { not: rentalId },
    },
    select: {
      id: true,
      reference: true,
      startAt: true,
      endAt: true,
      returnedAt: true,
      status: true,
    },
  });

  const clash = findRentalOverlap({ startAt, endAt }, existing);
  if (clash) {
    return {
      ok: false,
      message: `That vehicle is already on rental ${clash.reference} for part of this period`,
      rentalReference: clash.reference,
    };
  }

  await withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const before = await tx.vehicleRental.findUniqueOrThrow({
        where: { id: rentalId },
      });
      const after = await tx.vehicleRental.update({
        where: { id: rentalId },
        data: {
          vehicleId: input.vehicleId,
          renterType: input.renterType,
          driverId: input.renterType === 'DRIVER' ? input.driverId || null : null,
          // A one-off hirer saved as an account at booking keeps that link.
          // Clearing it on every edit would strand the customer record the
          // "save them as an account" tick was there to create.
          accountId:
            input.renterType === 'ACCOUNT'
              ? input.accountId || null
              : input.renterType === 'EXTERNAL'
                ? rental.accountId
                : null,
          hirerName: input.hirerName || null,
          hirerAddress: input.hirerAddress || null,
          hirerPhone: input.hirerPhone || null,
          hirerLicenceNumber: input.hirerLicenceNumber || null,
          startAt,
          endAt,
          rateType: input.rateType,
          ratePence: input.ratePence,
          depositPence: input.depositPence,
          mileageOut: input.mileageOut,
          fuelOutPct: input.fuelOutPct,
          mileageAllowancePerDay: input.mileageAllowancePerDay,
          excessMileagePence: input.excessMileagePence,
          advancePaymentPence: input.advancePaymentPence,
          minimumTermDays: input.minimumTermDays,
          insuranceExcessPence: input.insuranceExcessPence,
          congestionChargePence: input.congestionChargePence,
          smokingChargePence: input.smokingChargePence,
          panelRepairPence: input.panelRepairPence,
          wheelScratchPence: input.wheelScratchPence,
          depositReturnDays: input.depositReturnDays,
          ownerSignatory: input.ownerSignatory || null,
          notes: emptyToNull(input.notes),
        },
      });

      return { entityId: after.vehicleId, before, after, result: null };
    },
    context,
  );

  return { ok: true, id: rentalId };
}

/**
 * Call a hire off.
 *
 * The record stays and the car is freed. This is what a hire that was agreed
 * and then did not happen actually is — and unlike deleting it, the money
 * already taken against it is still on the books to be refunded rather than
 * quietly gone.
 */
export async function cancelRental(
  rentalId: string,
  context: AuditContext,
): Promise<RentalRefusal> {
  const rental = await prisma.vehicleRental.findUnique({
    where: { id: rentalId },
    select: { id: true, vehicleId: true, status: true },
  });
  if (!rental) return { ok: false, message: 'That hire no longer exists' };
  if (rental.status === 'CANCELLED') {
    return { ok: false, message: 'That hire is already cancelled' };
  }
  if (rental.status === 'RETURNED') {
    return {
      ok: false,
      // The car went out and came back. Cancelling it would claim it never
      // happened while the mileage on the car says otherwise.
      message:
        'That car has already been booked back in, so the hire happened. Correct its details instead of cancelling it.',
    };
  }

  await withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const before = await tx.vehicleRental.findUniqueOrThrow({
        where: { id: rentalId },
      });
      const after = await tx.vehicleRental.update({
        where: { id: rentalId },
        data: { status: 'CANCELLED' },
      });
      return { entityId: rental.vehicleId, before, after, result: null };
    },
    context,
  );

  return { ok: true };
}

/**
 * Remove a hire booked by mistake.
 *
 * A soft delete: the row stays, filtered out of every read — see
 * `SOFT_DELETE_MODELS` in `lib/prisma.ts`. There is no hard delete in this
 * application, and a hire is exactly the case that shows why. The car's
 * history is the thing somebody reconstructs later ("where was it in March,
 * and who had it"), and a row that is genuinely gone cannot answer.
 *
 * Refused once money has changed hands. A payment recorded against a hire
 * happened: it is on a bank statement, and making the hire disappear would
 * leave the receipt with nothing to reconcile against. Cancelling is the
 * honest version of that, so the refusal says so.
 */
export async function deleteRental(
  rentalId: string,
  context: AuditContext,
): Promise<RentalRefusal> {
  const rental = await prisma.vehicleRental.findUnique({
    where: { id: rentalId },
    select: {
      id: true,
      vehicleId: true,
      reference: true,
      status: true,
      payments: { select: { id: true }, take: 1 },
    },
  });
  if (!rental) return { ok: false, message: 'That hire no longer exists' };

  const editable = await rentalEditability(rentalId);
  if (!editable.ok) return editable;

  if (rental.payments.length > 0) {
    return {
      ok: false,
      message:
        'Money has been received against this hire, so deleting it would leave the payment with nothing to reconcile against. Cancel it instead — the record stays and the car is freed.',
    };
  }

  await withAudit(
    'Vehicle',
    'delete',
    async (tx) => {
      const before = await tx.vehicleRental.findUniqueOrThrow({
        where: { id: rentalId },
      });
      // `deletedAt` written directly, as every other archive in this codebase
      // does. The extension's `delete` rewrite runs against the base client,
      // so calling `tx.delete` here would land the write outside this
      // transaction and survive a rollback.
      const after = await tx.vehicleRental.update({
        where: { id: rentalId },
        data: { deletedAt: new Date() },
      });
      return { entityId: rental.vehicleId, before, after, result: null };
    },
    context,
  );

  return { ok: true };
}

export const returnSchema = z.object({
  returnedAt: z.string().trim().min(1, 'Enter when it came back'),
  mileageIn: optionalInt,
  fuelInPct: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : value),
    z.coerce.number().int().min(0).max(100).nullable(),
  ),
  damageNotes: z.string().trim().max(2000).optional().or(z.literal('')),
  damageChargePence: money,
});

export type ReturnInput = z.infer<typeof returnSchema>;

/**
 * Take a car back.
 *
 * Writes the return-phase checklist at the same time, so collection and
 * return are recorded against the same list and can be compared line by line.
 */
export async function returnRental(
  rentalId: string,
  input: ReturnInput,
  context: AuditContext,
): Promise<RentalRefusal> {
  const rental = await prisma.vehicleRental.findUnique({
    where: { id: rentalId },
    select: { id: true, vehicleId: true, startAt: true, status: true },
  });
  if (!rental) return { ok: false, message: 'That rental no longer exists' };
  if (rental.status === 'RETURNED') {
    return { ok: false, message: 'That car has already been booked back in' };
  }
  if (rental.status === 'CANCELLED') {
    return { ok: false, message: 'That rental was cancelled' };
  }

  const returnedAt = toUTC(input.returnedAt);
  if (returnedAt.getTime() < rental.startAt.getTime()) {
    return { ok: false, message: 'A car cannot come back before it went out' };
  }

  await withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const before = await tx.vehicleRental.findUniqueOrThrow({ where: { id: rentalId } });
      const after = await tx.vehicleRental.update({
        where: { id: rentalId },
        data: {
          returnedAt,
          mileageIn: input.mileageIn,
          fuelInPct: input.fuelInPct,
          damageNotes: emptyToNull(input.damageNotes),
          damageChargePence: input.damageChargePence,
          status: 'RETURNED',
        },
      });

      const alreadyChecked = await tx.rentalChecklistItem.count({
        where: { rentalId, phase: 'IN' },
      });
      if (alreadyChecked === 0) {
        await tx.rentalChecklistItem.createMany({
          data: DEFAULT_CHECKLIST_ITEMS.map((label) => ({
            rentalId,
            phase: 'IN' as const,
            label,
          })),
        });
      }

      return { entityId: rental.vehicleId, before, after, result: null };
    },
    context,
  );

  return { ok: true };
}

export async function recordRentalPayment(
  rentalId: string,
  amountPence: number,
  paidAt: Date,
  context: AuditContext,
  options: { method?: string | null; reference?: string | null } = {},
): Promise<RentalRefusal> {
  if (amountPence <= 0) {
    return { ok: false, message: 'Enter an amount greater than zero' };
  }

  const rental = await prisma.vehicleRental.findUnique({
    where: { id: rentalId },
    select: { vehicleId: true },
  });
  if (!rental) return { ok: false, message: 'That rental no longer exists' };

  await withAudit(
    'Vehicle',
    'update',
    async (tx) => {
      const created = await tx.rentalPayment.create({
        data: {
          rentalId,
          amountPence,
          paidAt,
          method: (options.method as never) ?? null,
          reference: emptyToNull(options.reference ?? null),
        },
      });
      return { entityId: rental.vehicleId, after: created, result: null };
    },
    context,
  );

  return { ok: true };
}

const RENTAL_INCLUDE = {
  vehicle: { select: { id: true, registration: true, make: true, model: true } },
  driver: { select: { id: true, name: true, reference: true, phone: true } },
  // A hire may have gone to a company instead of a driver.
  account: {
    select: { id: true, name: true, contactPhone: true, billingAddress: true },
  },
  payments: { orderBy: { paidAt: 'desc' } },
  checks: { orderBy: { label: 'asc' } },
} as const;

export async function getRental(id: string) {
  const rental = await prisma.vehicleRental.findUnique({
    where: { id },
    include: RENTAL_INCLUDE,
  });
  if (!rental) return null;
  return { ...rental, balance: rentalBalance(rental, rental.payments) };
}

export interface RentalListFilters {
  status: string | null;
  vehicleId: string | null;
  driverId: string | null;
  arrearsOnly: boolean;
}

export async function listRentals(
  params: { skip: number; take: number },
  filters: RentalListFilters,
) {
  const where = {
    ...(filters.status ? { status: filters.status as never } : {}),
    ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
    ...(filters.driverId ? { driverId: filters.driverId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.vehicleRental.findMany({
      where,
      orderBy: { startAt: 'desc' },
      // Arrears is derived from payments, so it cannot be a SQL filter without
      // duplicating the charging rules into the database where they would
      // drift. The fleet is small enough that paging the matched set in
      // memory is the honest trade — the same one listVehicles makes.
      ...(filters.arrearsOnly ? {} : { skip: params.skip, take: params.take }),
      include: {
        vehicle: { select: { id: true, registration: true } },
        driver: { select: { id: true, name: true } },
        account: { select: { id: true, name: true } },
        payments: { select: { amountPence: true } },
      },
    }),
    prisma.vehicleRental.count({ where }),
  ]);

  const decorated = rows.map((rental) => ({
    ...rental,
    balance: rentalBalance(rental, rental.payments),
  }));

  if (!filters.arrearsOnly) return { rows: decorated, total };

  const matching = decorated.filter((rental) => rental.balance.inArrears);
  return {
    rows: matching.slice(params.skip, params.skip + params.take),
    total: matching.length,
  };
}

/** Total owed across every open rental — the arrears figure for the dashboard. */
export async function totalRentalArrears(): Promise<{
  count: number;
  pence: number;
}> {
  const rentals = await prisma.vehicleRental.findMany({
    where: { status: { in: ['BOOKED', 'ACTIVE', 'RETURNED'] } },
    include: { payments: { select: { amountPence: true } } },
  });

  const owing = rentals
    .map((rental) => rentalBalance(rental, rental.payments))
    .filter((balance) => balance.inArrears);

  return {
    count: owing.length,
    pence: owing.reduce((total, balance) => total + balance.balancePence, 0),
  };
}

/**
 * Contract terms to start the next hire from.
 *
 * Taken from the most recent rental that had any, rather than from settings.
 * The operator asked for these to be editable when entering the hire, and in
 * practice they change rarely — so carrying the last agreement forward means
 * they are typed once and adjusted when a particular deal differs, instead of
 * being retyped in full every time.
 */
export async function lastContractTerms() {
  const previous = await prisma.vehicleRental.findFirst({
    where: { insuranceExcessPence: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: {
      mileageAllowancePerDay: true,
      minimumTermDays: true,
      depositReturnDays: true,
      excessMileagePence: true,
      insuranceExcessPence: true,
      congestionChargePence: true,
      smokingChargePence: true,
      panelRepairPence: true,
      wheelScratchPence: true,
      ownerSignatory: true,
    },
  });

  // Formatted for a text input, because that is what the person edits and
  // what the schema parses back into pence.
  const pounds = (pence: number | null | undefined) =>
    pence == null ? null : (pence / 100).toFixed(2);

  return {
    mileageAllowancePerDay: previous?.mileageAllowancePerDay ?? null,
    minimumTermDays: previous?.minimumTermDays ?? null,
    depositReturnDays: previous?.depositReturnDays ?? null,
    excessMileage: pounds(previous?.excessMileagePence),
    insuranceExcess: pounds(previous?.insuranceExcessPence),
    congestionCharge: pounds(previous?.congestionChargePence),
    smokingCharge: pounds(previous?.smokingChargePence),
    panelRepair: pounds(previous?.panelRepairPence),
    wheelScratch: pounds(previous?.wheelScratchPence),
    ownerSignatory: previous?.ownerSignatory ?? null,
  };
}
