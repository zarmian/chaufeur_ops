import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { checkDriverConflicts, checkVehicleConflicts } from '@/lib/conflict-store';
import { checkAssignmentCompliance, transitionJob } from '@/lib/jobs';
import { prisma } from '@/lib/prisma';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/dispatch/assign` — drop a job on a driver — spec 6.1.6.
 *
 * Two checks on the drop, and they behave differently on purpose.
 *
 * **Compliance blocks.** A driver with a lapsed PHV badge cannot be given a
 * job with a future pickup; that is a licensing requirement, not a
 * preference, and no amount of operator judgement changes it.
 *
 * **A conflict warns.** Two airport runs ninety minutes apart may be
 * perfectly workable, and the operator knows the traffic and the driver where
 * the system does not. Blocking here would teach people to route around the
 * board, which is how the legacy spreadsheet happened.
 *
 * JSON rather than a form post because the caller is a drag handler with no
 * form to submit, and it needs the warning back to show it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireCapability('dispatch');

  const body = (await request.json()) as { jobId?: string; driverId?: string };
  const jobId = String(body.jobId ?? '').trim();
  const driverId = String(body.driverId ?? '').trim();

  if (!jobId || !driverId) {
    return NextResponse.json(
      { ok: false, message: 'Which job, and which driver?' },
      { status: 400 },
    );
  }

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      reference: true,
      status: true,
      scheduledAt: true,
      estimatedMinutes: true,
      vehicleId: true,
      driverId: true,
      finance: { select: { customerHours: true } },
    },
  });

  if (!job) {
    return NextResponse.json({ ok: false, message: 'No such job' }, { status: 404 });
  }

  if (['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(job.status)) {
    return NextResponse.json(
      { ok: false, message: `${job.reference} has already finished.` },
      { status: 409 },
    );
  }

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { id: true, name: true, assignedVehicleId: true },
  });
  if (!driver) {
    return NextResponse.json({ ok: false, message: 'No such driver' }, { status: 404 });
  }

  // The driver's own car unless the job already names one — a job may
  // override the driver's assigned vehicle, and a drag must not undo that.
  const vehicleId = job.vehicleId ?? driver.assignedVehicleId;

  const compliance = await checkAssignmentCompliance(
    driverId,
    vehicleId,
    job.scheduledAt,
  );

  if (compliance && !compliance.compliant) {
    return NextResponse.json(
      {
        ok: false,
        message: `${driver.name} cannot take this job: ${compliance.reasons.join('; ')}`,
      },
      { status: 409 },
    );
  }

  const proposed = {
    id: job.id,
    scheduledAt: job.scheduledAt,
    estimatedMinutes: job.estimatedMinutes,
    customerHours: job.finance?.customerHours
      ? Number(job.finance.customerHours)
      : null,
  };

  const [driverClash, vehicleClash] = await Promise.all([
    checkDriverConflicts(driverId, proposed),
    checkVehicleConflicts(vehicleId, proposed),
  ]);

  const audit = { userId: user.id, ip: clientIpFrom(await headers()) };

  await prisma.job.update({
    where: { id: jobId },
    data: { driverId, ...(job.vehicleId ? {} : { vehicleId }) },
  });

  // Through `transitionJob` rather than a status write, so the assignment
  // event, the audit entry and the driver's Telegram brief all happen — a
  // drag must produce exactly what the form produces.
  const moved =
    job.status === 'PENDING' || job.status === 'DRAFT'
      ? await transitionJob(jobId, 'ASSIGNED', audit)
      : { ok: true as const };

  if (!moved.ok) {
    return NextResponse.json({ ok: false, message: moved.message }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    warning: driverClash.warning ?? vehicleClash.warning ?? null,
  });
});
