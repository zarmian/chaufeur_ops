import { getBranding } from './branding-store';
import { formatDate, formatDateTime } from './dates';
import { getLocaleConfig } from './locale-store';
import { prisma } from './prisma';
import {
  renderRentalContract,
  type ContractData,
} from './rental-contract';
import { chargeablePeriods, RATE_TYPE_UNIT, renterDetails } from './rentals';

/**
 * Gathering a rental into the shape the contract wants.
 *
 * Separate from `lib/rental-contract.ts` for the same reason the invoice and
 * the payout statement are split: the template is pure and testable, and this
 * is the half that talks to Postgres and to settings.
 *
 * Nothing here invents a term. A charge the operator did not set prints as a
 * rule to write on rather than as zero — an unset excess fee rendered as
 * "£0.00" is a contract saying the hirer owes nothing, which is not what a
 * blank field meant.
 */
export async function rentalContractHtml(
  rentalId: string,
  options: { logoSrc?: string | null } = {},
): Promise<string | null> {
  const rental = await prisma.vehicleRental.findUnique({
    where: { id: rentalId },
    include: {
      vehicle: true,
      driver: { select: { name: true, phone: true } },
      account: { select: { name: true, contactPhone: true, billingAddress: true } },
    },
  });
  if (!rental) return null;

  const [branding, locale] = await Promise.all([getBranding(), getLocaleConfig()]);

  const hirer = renterDetails(rental);
  // Days regardless of how the hire is charged: the contract's "fixed period
  // of hire" is a length of time, not a count of billing periods.
  const termDays = chargeablePeriods(rental.startAt, rental.endAt, 'DAILY');

  const data: ContractData = {
    reference: rental.reference,
    issuedOn: formatDate(new Date()),
    startAt: formatDateTime(rental.startAt),
    endAt: formatDateTime(rental.endAt),
    hirer,
    vehicle: {
      registration: rental.vehicle.registration,
      makeModel: [rental.vehicle.make, rental.vehicle.model, rental.vehicle.variant]
        .filter(Boolean)
        .join(' '),
      chassisNumber: rental.vehicle.chassisNumber,
      firstRegisteredOn: rental.vehicle.firstRegisteredOn
        ? formatDate(rental.vehicle.firstRegisteredOn)
        : null,
      valuePence: rental.vehicle.valuePence,
      insurerName: rental.vehicle.insurerName,
      policyNumber: rental.vehicle.insurancePolicyNo,
      mileageOut: rental.mileageOut,
    },
    terms: {
      termDays,
      minimumTermDays: rental.minimumTermDays,
      ratePence: rental.ratePence,
      rateUnit: RATE_TYPE_UNIT[rental.rateType],
      // How many rentals were taken up front, derived from what was actually
      // paid in advance rather than asked for twice.
      advanceRentals:
        rental.advancePaymentPence > 0 && rental.ratePence > 0
          ? Math.round((rental.advancePaymentPence / rental.ratePence) * 10) / 10
          : null,
      advancePaymentPence: rental.advancePaymentPence,
      depositPence: rental.depositPence,
      depositReturnDays: rental.depositReturnDays,
      mileageAllowancePerDay: rental.mileageAllowancePerDay,
      excessMileagePence: rental.excessMileagePence,
      insuranceExcessPence: rental.insuranceExcessPence,
      congestionChargePence: rental.congestionChargePence,
      smokingChargePence: rental.smokingChargePence,
      panelRepairPence: rental.panelRepairPence,
      wheelScratchPence: rental.wheelScratchPence,
    },
    ownerSignatory: rental.ownerSignatory,
  };

  return renderRentalContract(data, { branding, locale, logoSrc: options.logoSrc });
}

/**
 * Note that a contract has been produced.
 *
 * Recorded rather than inferred, so the rental screen can say "contract
 * raised on the 3rd" instead of leaving an operator to remember whether they
 * sent one.
 */
export async function markContractGenerated(rentalId: string): Promise<void> {
  await prisma.vehicleRental.update({
    where: { id: rentalId },
    data: { contractGeneratedAt: new Date() },
  });
}
