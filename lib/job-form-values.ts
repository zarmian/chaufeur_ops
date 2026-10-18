import type { StopValue } from '@/app/(dashboard)/jobs/stops-field';

/**
 * The booking form's own values, and an empty set of them.
 *
 * Split out of the form itself so that both sides can use them: the client
 * component that renders the fields, and the Server Components that pre-fill
 * them from a duplicate, a return leg or an agency job sheet.
 */

export interface JobFormValues {
  clientId: string;
  accountId: string;
  jobType: string;
  scheduledDate: string;
  scheduledTime: string;
  pickupText: string;
  pickupPostcode: string;
  pickupLat: string;
  pickupLng: string;
  dropoffText: string;
  dropoffPostcode: string;
  dropoffLat: string;
  dropoffLng: string;
  viaText: string;
  driverId: string;
  vehicleId: string;
  passengerName: string;
  passengerPhone: string;
  passengerCount: number | string;
  luggageCount: number | string;
  flightNumber: string;
  /** The booker's own reference — an agency's reservation number. */
  customerReference: string;
  clientPrice: string;
  driverPrice: string;
  /** Empty follows the booker. */
  vatTreatment: string;
  customerHours: string;
  customerRate: string;
  minimumHours: string;
  /** One day of a standing contract, charged at a day rate. */
  customerDays: string;
  customerDayRate: string;
  minimumDays: string;
  driverDays: string;
  driverDayRate: string;
  shiftId: string;
  stops: StopValue[];
  notes: string;
  internalNotes: string;
}

/**
 * Every field empty.
 *
 * Here rather than in `job-form.tsx` because a Server Component has to be able
 * to read it: a pre-filled form starts from this and overwrites what it knows,
 * so that adding a field to the form cannot leave a pre-fill silently missing
 * it. A plain object exported from a `'use client'` module is a client
 * reference on the server, not the object — spreading it yields nothing, and
 * the form then crashes on the first field it tries to trim.
 */
export const BLANK_JOB_VALUES: JobFormValues = {
  clientId: '',
  accountId: '',
  jobType: 'TRANSFER',
  scheduledDate: '',
  scheduledTime: '',
  pickupText: '',
  pickupPostcode: '',
  pickupLat: '',
  pickupLng: '',
  dropoffText: '',
  dropoffPostcode: '',
  dropoffLat: '',
  dropoffLng: '',
  viaText: '',
  driverId: '',
  vehicleId: '',
  passengerName: '',
  passengerPhone: '',
  passengerCount: '',
  luggageCount: '',
  flightNumber: '',
  customerReference: '',
  clientPrice: '',
  driverPrice: '',
  vatTreatment: '',
  customerHours: '',
  customerRate: '',
  minimumHours: '',
  customerDays: '',
  customerDayRate: '',
  minimumDays: '',
  driverDays: '',
  driverDayRate: '',
  shiftId: '',
  stops: [],
  notes: '',
  internalNotes: '',
};
