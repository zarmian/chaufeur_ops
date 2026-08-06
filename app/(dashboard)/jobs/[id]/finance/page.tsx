import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { can } from '@/lib/authz';
import { toDateOnlyString } from '@/lib/dates';
import { waitMinutesFromEvents } from '@/lib/job-events';
import { prefillFromBooking } from '@/lib/job-finance';
import { getJob } from '@/lib/jobs';
import { pageRequireCapability } from '@/lib/page-guards';
import { saveFinanceAction } from '../../actions';
import { FinanceForm } from './finance-form';

export const metadata = { title: 'Job finances' };

export default async function JobFinancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // OPS may look but not touch (spec 2.5.8), so the guard is the *view*
  // capability and the write capability decides whether it is editable.
  const user = await pageRequireCapability('viewJobs');
  const { id } = await params;

  const job = await getJob(id);
  if (!job) notFound();

  const readOnly = !can(user, 'editJobFinances');

  // A job with a booking price but no finance record starts from those
  // prices, rather than from zero and inviting someone to retype them.
  const prefill = prefillFromBooking(job);
  const finance = job.finance;

  return (
    <>
      <PageHeader
        title={`Finances · ${job.reference}`}
        description={`${job.pickupText} → ${job.dropoffText}`}
      />
      <FinanceForm
        action={saveFinanceAction.bind(null, job.id)}
        cancelHref={`/jobs/${job.id}`}
        readOnly={readOnly}
        waitMinutesFromEvents={waitMinutesFromEvents(job.events)}
        autoWait={
          finance?.waitAutoCalculatedAt || finance?.waitOverriddenById
            ? {
                explanation: waitExplanation(finance),
                overriddenBy: finance.waitOverriddenById,
              }
            : null
        }
        values={{
          baseFarePence: finance?.baseFarePence ?? prefill.baseFarePence ?? 0,
          waitTimePence: finance?.waitTimePence ?? 0,
          waitMinutesBilled: finance?.waitMinutesBilled ?? 0,
          extraChargesPence: finance?.extraChargesPence ?? 0,
          extraChargesNotes: finance?.extraChargesNotes ?? '',
          customerHours: finance?.customerHours?.toString() ?? '',
          customerRatePence: finance?.customerRatePence ?? 0,
          driverPaymentPence:
            finance?.driverPaymentPence ?? prefill.driverPaymentPence ?? 0,
          fuelCostPence: finance?.fuelCostPence ?? 0,
          otherExpensesPence: finance?.otherExpensesPence ?? 0,
          expenseNotes: finance?.expenseNotes ?? '',
          driverHours: finance?.driverHours?.toString() ?? '',
          driverRatePence: finance?.driverRatePence ?? 0,
          driverPayStatus: finance?.driverPayStatus ?? 'UNPAID',
          driverPayMethod: finance?.driverPayMethod ?? '',
          driverPaidAt: finance?.driverPaidAt
            ? toDateOnlyString(finance.driverPaidAt)
            : '',
          paymentNotes: finance?.paymentNotes ?? '',
        }}
      />
    </>
  );
}

/**
 * The derivation, in words — spec 5.5.4.
 *
 * Shown beside the figure so nobody has to trust it blindly, and so a wait a
 * client disputes can be argued from the timeline rather than from memory.
 */
function waitExplanation(finance: {
  waitMinutesBilled: number;
  waitTimePence: number;
  waitOverrideReason: string | null;
}): string {
  if (finance.waitOverrideReason) {
    return `Overridden: ${finance.waitOverrideReason}`;
  }
  if (finance.waitMinutesBilled === 0) {
    return 'The wait was inside the free allowance, so there is nothing to charge.';
  }
  return `${finance.waitMinutesBilled} billable minutes from the driver's taps.`;
}
