import type { Branding } from './branding';
import { escapeHtml } from './invoice-document';
import type { LocaleConfig } from './locale';
import { formatMoney } from './money';

/**
 * The hire contract, as one document.
 *
 * The operator's paperwork is three separate files — a contract of hire, an
 * acceptance of vehicle liability, and terms and conditions — signed together
 * and sent together. They are one PDF here because that is what actually goes
 * to a renter: three attachments is three chances to sign two of them.
 *
 * A pure HTML builder, like the invoice and the driver statement, so the
 * wording and the arithmetic can be tested without starting a browser.
 *
 * Everything customer-specific arrives in `ContractData`. There is no WeLux
 * in this file: the charges are what the operator typed on the rental, and
 * the company details come from branding. A second customer with different
 * excess fees gets their own contract from the same template.
 */

export interface ContractParty {
  name: string;
  address: string | null;
  phone: string | null;
  licenceNumber: string | null;
}

export interface ContractVehicle {
  registration: string;
  makeModel: string;
  chassisNumber: string | null;
  firstRegisteredOn: string | null;
  valuePence: number | null;
  insurerName: string | null;
  policyNumber: string | null;
  mileageOut: number | null;
}

export interface ContractTerms {
  /** Hire period, in days, including part days. */
  termDays: number;
  minimumTermDays: number | null;
  ratePence: number;
  rateUnit: string;
  /** Rentals payable in advance, in the same unit as the rate. */
  advanceRentals: number | null;
  advancePaymentPence: number;
  depositPence: number;
  depositReturnDays: number | null;
  mileageAllowancePerDay: number | null;
  excessMileagePence: number | null;
  insuranceExcessPence: number | null;
  congestionChargePence: number | null;
  smokingChargePence: number | null;
  panelRepairPence: number | null;
  wheelScratchPence: number | null;
}

export interface ContractData {
  reference: string;
  issuedOn: string;
  startAt: string;
  endAt: string;
  hirer: ContractParty;
  vehicle: ContractVehicle;
  terms: ContractTerms;
  ownerSignatory: string | null;
}

const money = (pence: number | null | undefined, locale: LocaleConfig): string =>
  pence == null ? '—' : formatMoney(pence, locale);

const orDash = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : escapeHtml(String(value));

/**
 * A blank to be filled by hand.
 *
 * The samples this replaces left several values as "__" in the printed terms
 * — the term length, the minimum period — and an operator filled them in with
 * a pen. Anything the system knows is printed; anything it does not still
 * gets a rule to write on, rather than a silent gap that reads as "none".
 */
const RULE = '<span class="rule"></span>';

function periodRow(label: string, value: string): string {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${value}</td></tr>`;
}

export function renderRentalContract(
  data: ContractData,
  options: { branding: Branding; locale: LocaleConfig; logoSrc?: string | null },
): string {
  const { branding, locale } = options;
  const { hirer, vehicle, terms } = data;

  const company = escapeHtml(branding.tradingName);
  const days = (n: number | null) => (n == null ? RULE : `${n}`);

  // Section 1 — the contract of hire.
  const hireRows = [
    periodRow('A. Fixed period of hire beginning on the commencement date', `${terms.termDays} days`),
    periodRow('B. Total number of rentals', `${terms.termDays}`),
    periodRow(
      `C. Amount of each ${terms.rateUnit} rental (inc. tax)`,
      money(terms.ratePence, locale),
    ),
    periodRow(
      'D. Number of rentals in advance',
      terms.advanceRentals == null ? RULE : `${terms.advanceRentals}`,
    ),
    periodRow('E. Total advance payment', money(terms.advancePaymentPence, locale)),
    periodRow(
      'F. Daily mileage allowance',
      terms.mileageAllowancePerDay == null
        ? RULE
        : `${terms.mileageAllowancePerDay} miles`,
    ),
    periodRow(
      'G. Excess mileage charge per mile',
      money(terms.excessMileagePence, locale),
    ),
    periodRow('Deposit', money(terms.depositPence, locale)),
  ].join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hire agreement ${escapeHtml(data.reference)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 10.5pt; line-height: 1.45; color: #111; margin: 0;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start;
    gap: 16mm; border-bottom: 2px solid #111; padding-bottom: 6mm; margin-bottom: 8mm; }
  .brand { font-size: 13pt; font-weight: 700; letter-spacing: .02em; }
  .company { font-size: 8.5pt; color: #555; line-height: 1.4; }
  img.logo { max-height: 18mm; max-width: 55mm; object-fit: contain; }
  h1 { font-size: 15pt; margin: 0 0 1mm; letter-spacing: .04em; text-transform: uppercase; }
  h2 { font-size: 11pt; margin: 8mm 0 3mm; text-transform: uppercase; letter-spacing: .06em;
    border-bottom: 1px solid #bbb; padding-bottom: 1.5mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 1.6mm 2mm; }
  th[scope="row"] { font-weight: 500; width: 62%; color: #333; }
  tbody tr:nth-child(odd) { background: #f6f6f6; }
  td { font-variant-numeric: tabular-nums; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8mm; }
  .field { padding: 1.6mm 0; border-bottom: 1px solid #e2e2e2; }
  .field .label { font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; color: #666; }
  .field .value { font-weight: 500; }
  .rule { display: inline-block; min-width: 22mm; border-bottom: 1px solid #666; }
  ol, ul { margin: 0 0 0 5mm; padding: 0; }
  li { margin: 0 0 1.8mm; }
  .page-break { break-before: page; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 10mm; }
  .sign .box { border-top: 1px solid #111; padding-top: 2mm; }
  .sign .who { font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; color: #666; }
  .sign .line { margin-top: 9mm; border-bottom: 1px solid #666; }
  .sign .cap { font-size: 8pt; color: #666; margin-top: 1.5mm; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; font-size: 7.5pt;
    color: #777; border-top: 1px solid #ddd; padding-top: 2mm; }
</style>
</head>
<body>

<header>
  <div>
    <h1>Contract hire agreement</h1>
    <div class="company">Agreement ${escapeHtml(data.reference)} · ${escapeHtml(data.issuedOn)}</div>
  </div>
  <div style="text-align:right">
    ${options.logoSrc ? `<img class="logo" src="${escapeHtml(options.logoSrc)}" alt="">` : `<div class="brand">${company}</div>`}
    <div class="company">${escapeHtml((branding.addressLines ?? '').replace(/\n+/g, ', '))}</div>
  </div>
</header>

<h2>Hirer</h2>
<div class="pair">
  <div class="field"><div class="label">Hirer</div><div class="value">${orDash(hirer.name)}</div></div>
  <div class="field"><div class="label">Contact number</div><div class="value">${orDash(hirer.phone)}</div></div>
  <div class="field"><div class="label">Address</div><div class="value">${orDash(hirer.address)}</div></div>
  <div class="field"><div class="label">Driving licence number</div><div class="value">${orDash(hirer.licenceNumber)}</div></div>
</div>

<h2>Vehicle</h2>
<div class="pair">
  <div class="field"><div class="label">Make and model</div><div class="value">${orDash(vehicle.makeModel)}</div></div>
  <div class="field"><div class="label">Registration number</div><div class="value">${orDash(vehicle.registration)}</div></div>
  <div class="field"><div class="label">Registration date</div><div class="value">${orDash(vehicle.firstRegisteredOn)}</div></div>
  <div class="field"><div class="label">Chassis number</div><div class="value">${orDash(vehicle.chassisNumber)}</div></div>
  <div class="field"><div class="label">Mileage at handover</div><div class="value">${vehicle.mileageOut == null ? '—' : `${vehicle.mileageOut.toLocaleString('en-GB')} miles`}</div></div>
  <div class="field"><div class="label">Vehicle value</div><div class="value">${money(vehicle.valuePence, locale)}</div></div>
</div>

<h2>Contract details</h2>
<div class="pair">
  <div class="field"><div class="label">Start date and time</div><div class="value">${orDash(data.startAt)}</div></div>
  <div class="field"><div class="label">Expiry date and time</div><div class="value">${orDash(data.endAt)}</div></div>
</div>
<table><tbody>${hireRows}</tbody></table>

<div class="sign">
  <div class="box">
    <div class="who">The owner</div>
    <div>${orDash(data.ownerSignatory ?? company)}</div>
    <div class="line"></div><div class="cap">Signature</div>
    <div class="line"></div><div class="cap">Date</div>
  </div>
  <div class="box">
    <div class="who">The hirer</div>
    <div>${orDash(hirer.name)}</div>
    <div class="line"></div><div class="cap">Signature</div>
    <div class="line"></div><div class="cap">Date</div>
  </div>
</div>

<section class="page-break">
  <h1>Confirmation and acceptance of vehicle liability</h1>
  <div class="pair" style="margin-top:5mm">
    <div class="field"><div class="label">Name</div><div class="value">${orDash(hirer.name)}</div></div>
    <div class="field"><div class="label">Date</div><div class="value">${orDash(data.issuedOn)}</div></div>
    <div class="field"><div class="label">Address</div><div class="value">${orDash(hirer.address)}</div></div>
    <div class="field"><div class="label">Vehicle registration</div><div class="value">${orDash(vehicle.registration)}</div></div>
    <div class="field"><div class="label">Make and model</div><div class="value">${orDash(vehicle.makeModel)}</div></div>
    <div class="field"><div class="label">Vehicle value</div><div class="value">${money(vehicle.valuePence, locale)}</div></div>
    <div class="field"><div class="label">Insurance company</div><div class="value">${orDash(vehicle.insurerName)}</div></div>
    <div class="field"><div class="label">Policy number</div><div class="value">${orDash(vehicle.policyNumber)}</div></div>
  </div>

  <ol style="margin-top:5mm">
    <li>I confirm that I hold a valid driving licence, have no more than six penalty
      points, have never been refused insurance, have never been convicted of fraud or
      any other criminal offence, and have never been convicted of drink or drug driving.</li>
    <li>In the event of any insurance claim — accident, damage, fire, theft or any other
      damage to the vehicle — which results in a refusal of liability or payment by the
      insurer for a reason that holds the driver responsible, such as false or incomplete
      information, I accept full responsibility for the full cost of the vehicle.</li>
    <li>In the event of a fault accident, an excess fee of
      ${money(terms.insuranceExcessPence, locale)} is payable by the hirer in full.</li>
    <li>In the event of any fault or non-fault claim that takes the vehicle off the road,
      I agree to pay the full ${escapeHtml(terms.rateUnit)} rent until the case is resolved
      and the vehicle has been returned in roadworthy condition.</li>
    <li>I confirm that I will keep the vehicle and its keys safe and will not leave it
      unattended. If the vehicle is stolen while switched on and unattended, and the
      insurer refuses liability as a result, the hirer is liable for the cost.</li>
  </ol>

  <div class="sign">
    <div class="box">
      <div class="who">Hirer</div>
      <div>${orDash(hirer.name)}</div>
      <div class="line"></div><div class="cap">Signature</div>
      <div class="line"></div><div class="cap">Date</div>
    </div>
    <div class="box">
      <div class="who">For ${company}</div>
      <div>${orDash(data.ownerSignatory ?? company)}</div>
      <div class="line"></div><div class="cap">Signature</div>
      <div class="line"></div><div class="cap">Date</div>
    </div>
  </div>
</section>

<section class="page-break">
  <h1>Terms and conditions</h1>
  <div class="company" style="margin-bottom:4mm">
    ${escapeHtml(vehicle.makeModel)} · ${escapeHtml(vehicle.registration)} · ${escapeHtml(data.issuedOn)}
  </div>

  <h2>Acceptance</h2>
  <ul>
    <li>I have read and understood these terms and conditions and agree to follow them.</li>
    <li>I acknowledge having received a copy of this agreement.</li>
    <li>I confirm that this agreement was completed before my signature.</li>
    <li>${company} reserves the right to terminate the contract at any time.</li>
    <li>Only the hirer is authorised to drive this vehicle. No one else may drive it, and
      no one else is covered by the insurance.</li>
    <li>The insurance claim excess fee is ${money(terms.insuranceExcessPence, locale)}.</li>
    <li>In the event of a fault claim, ${money(terms.insuranceExcessPence, locale)} must be
      paid within seven days of the claim or accident.</li>
    <li>It is your responsibility to keep the vehicle keys safe and in your possession.
      Keys left unattended may cause the insurer to refuse a theft claim.</li>
    <li>We strongly advise against leaving the vehicle running while loading or unloading
      luggage and passengers.</li>
    <li>In a hijack situation, turn the vehicle off: the immobiliser prevents it from
      restarting without the code.</li>
    <li>If the hirer intends to take the vehicle outside the agreed area, they must inform
      us immediately. Otherwise the vehicle may be immobilised automatically and a call-out
      charge will be required to release it.</li>
  </ul>

  <h2>Rent and deposit</h2>
  <ul>
    <li>The contract term is ${days(terms.termDays)} days.</li>
    <li>Rent must be paid in full on the agreed day. Failure to pay any outstanding amount
      within 48 hours of the due date will result in repossession of the vehicle and
      instruction of a debt recovery agent, with interest of 10% per week and an agency fee.</li>
    <li>You may cancel at any time; however the minimum contract is
      ${days(terms.minimumTermDays)} days. If the vehicle is returned before the end of that
      period, the full rent for ${days(terms.minimumTermDays)} days remains payable.</li>
    <li>One day's notice must be given, and the vehicle must be presented to ${company}
      for inspection before it is returned.</li>
    <li>Any outstanding balance must be cleared before the vehicle is returned; otherwise
      it will not be accepted back from the hirer's possession.</li>
    <li>The deposit of ${money(terms.depositPence, locale)} is returned
      ${terms.depositReturnDays == null ? RULE : terms.depositReturnDays} days after the
      vehicle is received.</li>
  </ul>

  <h2>Congestion charges and penalties</h2>
  <ul>
    <li>The hirer is responsible for any penalties or tickets issued during the contract.</li>
    <li>The hirer may not appeal a fine or ticket unless authorised to do so.</li>
    <li>${company} reserves the right to disclose the hirer's details to third parties such
      as private parking operators and law enforcement agencies.</li>
    <li>Our vehicles are registered for automatic congestion charge payment at
      ${money(terms.congestionChargePence, locale)} per day. Charges are notified weekly.
      Where the charging system applies a charge late, it will appear on a subsequent
      invoice and you will be informed.</li>
  </ul>

  <h2>Maintenance, breakdowns and damage</h2>
  <ul>
    <li>Neither the driver nor passengers may smoke or vape in the vehicle. Any smoke or
      vape smell will incur a detailing charge of ${money(terms.smokingChargePence, locale)}.</li>
    <li>A minor wheel scratch will be charged at
      ${money(terms.wheelScratchPence, locale)}. Multiple scratches will be charged at the
      full wheel refurbishment cost.</li>
    <li>A punctured tyre that cannot be repaired will be charged at the cost of a
      replacement of the same brand.</li>
    <li>Any minor scratch will be charged at ${money(terms.panelRepairPence, locale)} per
      panel. Larger damage will be charged at the full panel repair cost.</li>
    <li>Any other damage to the exterior or interior will be charged at the cost of repair
      or replacement.</li>
    <li>You must inform us of any claim within 24 hours. Failure to do so may cause our
      insurer to refuse the claim.</li>
    <li>The vehicle is maintained by ${company}, but it is the hirer's duty to look after
      it and to check engine oil, brake fluid, coolant, tyre pressures and bulbs regularly.</li>
    <li>The hirer must bring the vehicle to our designated garage for repairs, licensing
      appointments, MOT or any other appointment at the agreed time. Failure to attend may
      incur a cost payable by the hirer in full.</li>
    <li>Any warning light must be reported to ${company} immediately. Continuing to drive
      with a warning light showing will make the hirer liable for any resulting mechanical
      or electrical damage.</li>
  </ul>

  <div class="sign">
    <div class="box">
      <div class="who">Hirer</div>
      <div>${orDash(hirer.name)}</div>
      <div class="line"></div><div class="cap">Signature</div>
      <div class="line"></div><div class="cap">Date</div>
    </div>
    <div class="box">
      <div class="who">For ${company}</div>
      <div>${orDash(data.ownerSignatory ?? company)}</div>
      <div class="line"></div><div class="cap">Signature</div>
      <div class="line"></div><div class="cap">Date</div>
    </div>
  </div>
</section>

<footer>${company}${branding.companyNumber ? ` · Company registration ${escapeHtml(branding.companyNumber)}` : ''} · Agreement ${escapeHtml(data.reference)}</footer>
</body>
</html>`;
}
