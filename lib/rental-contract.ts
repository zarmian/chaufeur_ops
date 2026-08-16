import type { Branding } from './branding';
import { escapeHtml } from './invoice-document';
import type { LocaleConfig } from './locale';
import { formatMoney } from './money';

/**
 * The hire agreement.
 *
 * It replaces three separate files the operator used to send — a contract of
 * hire, an acceptance of vehicle liability, and terms and conditions — and it
 * is deliberately not those three stapled together. One title, one run of
 * numbered clauses, and **one place to sign at the end**. A renter asked to
 * sign three times signs twice and posts back a document that is missing a
 * page; a single execution block covering the whole agreement cannot be
 * half-completed.
 *
 * A pure HTML builder, like the invoice and the driver statement, so the
 * wording and the arithmetic can be tested without starting a browser.
 *
 * Everything customer-specific arrives in `ContractData`. No operator is
 * named here: the charges are what was typed on the rental and the company
 * comes from branding, so the next install does not send out this one's terms.
 *
 * The page footer is Chromium's, set in `lib/pdf.ts`, not an element in this
 * document. A `position: fixed` footer reserves no space and body text runs
 * underneath it.
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

/**
 * A blank to be filled by hand.
 *
 * The paperwork this replaces left several values as "__" for somebody to
 * complete with a pen. Anything the system knows is printed; anything it does
 * not still gets a line, rather than a gap that reads as "none".
 */
const RULE = '<span class="rule"></span>';

const money = (pence: number | null | undefined, locale: LocaleConfig): string =>
  pence == null ? '—' : formatMoney(pence, locale);

/**
 * Money inside a clause the parties are agreeing to.
 *
 * A dash is fine in a table of facts about the car — "Vehicle value: —" reads
 * as "not recorded". Inside a sentence it does not: "an excess fee of — is
 * payable by the hirer" is a term nobody can enforce or dispute. An amount
 * that was never agreed gets a line to write on instead.
 */
const agreed = (pence: number | null | undefined, locale: LocaleConfig): string =>
  pence == null ? RULE : formatMoney(pence, locale);

const orDash = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : escapeHtml(String(value));

const field = (label: string, value: string) =>
  `<div class="field"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;

const row = (label: string, value: string) =>
  `<tr><th scope="row">${escapeHtml(label)}</th><td>${value}</td></tr>`;

const clause = (text: string) => `<li>${text}</li>`;

export function renderRentalContract(
  data: ContractData,
  options: { branding: Branding; locale: LocaleConfig; logoSrc?: string | null },
): string {
  const { branding, locale } = options;
  const { hirer, vehicle, terms } = data;

  const company = escapeHtml(branding.tradingName);
  const days = (n: number | null) => (n == null ? RULE : `${n}`);
  const address = escapeHtml((branding.addressLines ?? '').replace(/\n+/g, ', '));

  const charges = [
    row('Fixed period of hire, from the commencement date', `${terms.termDays} days`),
    row('Total number of rentals', `${terms.termDays}`),
    row(`Amount of each ${terms.rateUnit} rental, including tax`, money(terms.ratePence, locale)),
    row(
      'Number of rentals payable in advance',
      terms.advanceRentals == null ? RULE : `${terms.advanceRentals}`,
    ),
    row('Total advance payment', money(terms.advancePaymentPence, locale)),
    row('Deposit', money(terms.depositPence, locale)),
    row(
      'Daily mileage allowance',
      terms.mileageAllowancePerDay == null ? RULE : `${terms.mileageAllowancePerDay} miles`,
    ),
    row('Excess mileage charge, per mile', agreed(terms.excessMileagePence, locale)),
  ].join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Vehicle hire agreement ${escapeHtml(data.reference)}</title>
<style>
  /* Bottom margin is Chromium's, reserved for the running footer. */
  @page { size: A4; margin: 16mm 15mm 0; }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 10pt; line-height: 1.5; color: #1a1a1a; margin: 0;
    counter-reset: section;
  }

  .masthead {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 12mm; padding-bottom: 4mm; border-bottom: 2.5pt solid #1a1a1a;
  }
  .masthead .who { font-size: 12pt; font-weight: 700; letter-spacing: .01em; }
  .masthead .meta { font-size: 8pt; color: #666; line-height: 1.5; text-align: right; }
  img.logo { max-height: 16mm; max-width: 50mm; object-fit: contain; }

  .title { margin: 7mm 0 1mm; font-size: 16pt; font-weight: 700;
    letter-spacing: .06em; text-transform: uppercase; }
  .between { color: #555; margin: 0 0 6mm; font-size: 9.5pt; }

  h2 {
    font-size: 10pt; margin: 7mm 0 2.5mm; text-transform: uppercase;
    letter-spacing: .08em; color: #1a1a1a;
    /* Numbered by the stylesheet, so inserting a section never renumbers by
       hand — and the run is continuous, which is what makes it read as one
       agreement rather than three documents stapled together. */
    counter-increment: section; counter-reset: clause;
    border-bottom: .75pt solid #d4d4d4; padding-bottom: 1.5mm;
    break-after: avoid; page-break-after: avoid;
  }
  h2::before { content: counter(section) ". "; color: #666; }

  dl.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8mm; margin: 0; }
  .field { padding: 1.8mm 0; border-bottom: .5pt solid #e6e6e6; break-inside: avoid; }
  .field dt { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .06em; color: #777; }
  .field dd { margin: .6mm 0 0; font-weight: 500; }

  table { width: 100%; border-collapse: collapse; margin-top: 1mm; }
  th, td { text-align: left; vertical-align: top; padding: 1.7mm 2.5mm; }
  th[scope="row"] { font-weight: 400; width: 64%; color: #333; }
  td { font-variant-numeric: tabular-nums; font-weight: 500; white-space: nowrap; }
  tbody tr { border-bottom: .5pt solid #ececec; break-inside: avoid; }

  ol.clauses { list-style: none; margin: 0; padding: 0; }
  /* The number is a flex item, not an absolutely-positioned marker: an
     out-of-flow marker can be left behind at the foot of a page while its
     clause moves to the next, which printed "7.1" alone above the footer. */
  ol.clauses > li {
    counter-increment: clause; margin: 0 0 2.2mm;
    display: flex; gap: 4mm; break-inside: avoid; page-break-inside: avoid;
  }
  ol.clauses > li::before {
    content: counter(section) "." counter(clause);
    flex: 0 0 9mm; color: #666; font-variant-numeric: tabular-nums;
  }

  .rule { display: inline-block; min-width: 24mm; border-bottom: .75pt solid #555;
    vertical-align: baseline; }

  /* One execution block, for the whole agreement. */
  .execution { break-inside: avoid; margin-top: 8mm; padding-top: 4mm;
    border-top: 2.5pt solid #1a1a1a; }
  .declaration { font-size: 9.5pt; margin: 0 0 6mm; }
  .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 12mm; }
  .party { break-inside: avoid; }
  .party .role { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .06em;
    color: #777; margin-bottom: 1mm; }
  .party .name { font-weight: 600; min-height: 5mm; }
  .slot { margin-top: 7mm; }
  .slot .line { border-bottom: .75pt solid #555; height: 8mm; }
  .slot .cap { font-size: 7.5pt; color: #777; margin-top: 1mm; }
</style>
</head>
<body>

<div class="masthead">
  <div>
    ${options.logoSrc
      ? `<img class="logo" src="${escapeHtml(options.logoSrc)}" alt="${company}">`
      : `<div class="who">${company}</div>`}
    ${address ? `<div class="meta" style="text-align:left">${address}</div>` : ''}
  </div>
  <div class="meta">
    Agreement ${escapeHtml(data.reference)}<br>
    ${escapeHtml(data.issuedOn)}
    ${branding.companyNumber ? `<br>Company registration ${escapeHtml(branding.companyNumber)}` : ''}
  </div>
</div>

<div class="title">Vehicle hire agreement</div>
<p class="between">
  Made between <strong>${company}</strong> (the Owner) and
  <strong>${orDash(hirer.name)}</strong> (the Hirer), on the terms set out below.
</p>

<h2>The Hirer</h2>
<dl class="grid">
  ${field('Name', orDash(hirer.name))}
  ${field('Contact number', orDash(hirer.phone))}
  ${field('Address', orDash(hirer.address))}
  ${field('Driving licence number', orDash(hirer.licenceNumber))}
</dl>

<h2>The vehicle</h2>
<dl class="grid">
  ${field('Make and model', orDash(vehicle.makeModel))}
  ${field('Registration number', orDash(vehicle.registration))}
  ${field('Date first registered', orDash(vehicle.firstRegisteredOn))}
  ${field('Chassis number', orDash(vehicle.chassisNumber))}
  ${field('Mileage at handover', vehicle.mileageOut == null
    ? '—'
    : `${vehicle.mileageOut.toLocaleString('en-GB')} miles`)}
  ${field('Agreed value', money(vehicle.valuePence, locale))}
  ${field('Insurer', orDash(vehicle.insurerName))}
  ${field('Policy number', orDash(vehicle.policyNumber))}
</dl>

<h2>Period and charges</h2>
<dl class="grid">
  ${field('Hire begins', orDash(data.startAt))}
  ${field('Hire ends', orDash(data.endAt))}
</dl>
<table><tbody>${charges}</tbody></table>

<h2>Insurance and liability</h2>
<ol class="clauses">
  ${clause(`The Hirer confirms that they hold a valid driving licence, have no more than
    six penalty points, have never been refused insurance, have never been convicted of
    fraud or any other criminal offence, and have never been convicted of drink or drug
    driving.`)}
  ${clause(`Where any claim — accident, damage, fire, theft or otherwise — results in the
    insurer refusing liability or payment for a reason that holds the driver responsible,
    including false or incomplete information, the Hirer accepts full responsibility for
    the full cost of the vehicle.`)}
  ${clause(`In the event of a fault accident, an excess fee of
    ${agreed(terms.insuranceExcessPence, locale)} is payable by the Hirer in full, within
    seven days of the claim or accident.`)}
  ${clause(`Where any fault or non-fault claim takes the vehicle off the road, the Hirer
    agrees to pay the full ${escapeHtml(terms.rateUnit)} rent until the case is resolved
    and the vehicle has been returned in roadworthy condition.`)}
  ${clause(`The Hirer will keep the vehicle and its keys safe and will not leave either
    unattended. Where the vehicle is stolen while switched on or unattended and the
    insurer refuses liability as a result, the Hirer is liable for the cost.`)}
</ol>

<h2>Use of the vehicle</h2>
<ol class="clauses">
  ${clause(`Only the Hirer is authorised to drive this vehicle. No one else may drive it,
    and no one else is covered by the insurance.`)}
  ${clause(`The Owner may terminate this agreement at any time.`)}
  ${clause(`The Owner advises against leaving the vehicle running while loading or
    unloading luggage and passengers.`)}
  ${clause(`In a hijack situation the Hirer should turn the vehicle off; the immobiliser
    prevents it from restarting without the code.`)}
  ${clause(`Where the Hirer intends to take the vehicle outside the agreed area, they must
    inform the Owner in advance. Otherwise the vehicle may be immobilised automatically
    and a call-out charge will be required to release it.`)}
</ol>

<h2>Rent and deposit</h2>
<ol class="clauses">
  ${clause(`The contract term is ${days(terms.termDays)} days, with a minimum of
    ${days(terms.minimumTermDays)} days. The Hirer may cancel at any time, but where the
    vehicle is returned before the end of the minimum period the full rent for that
    period remains payable.`)}
  ${clause(`Rent is payable in full on the agreed day. Failure to pay any outstanding
    amount within 48 hours of the due date will result in repossession of the vehicle and
    instruction of a debt recovery agent, with interest of 10% per week and an agency
    fee.`)}
  ${clause(`One day's notice must be given before return, and the vehicle must be
    presented to the Owner for inspection.`)}
  ${clause(`Any outstanding balance must be cleared before the vehicle is returned;
    otherwise it will not be accepted back from the Hirer's possession.`)}
  ${clause(`The deposit of ${agreed(terms.depositPence, locale)} is returned
    ${days(terms.depositReturnDays)} days after the vehicle is received.`)}
</ol>

<h2>Charges and penalties</h2>
<ol class="clauses">
  ${clause(`The Hirer is responsible for any penalties or tickets issued during the
    contract, and may not appeal a fine or ticket unless authorised to do so.`)}
  ${clause(`The Owner may disclose the Hirer's details to third parties such as private
    parking operators and law enforcement agencies.`)}
  ${clause(`The vehicle is registered for automatic congestion charge payment at
    ${agreed(terms.congestionChargePence, locale)} per day. Charges are notified weekly.
    Where the charging authority applies a charge late, it will appear on a subsequent
    invoice and the Hirer will be informed.`)}
</ol>

<h2>Maintenance, damage and breakdown</h2>
<ol class="clauses">
  ${clause(`Neither the Hirer nor passengers may smoke or vape in the vehicle. Any smoke
    or vape smell will incur a detailing charge of
    ${agreed(terms.smokingChargePence, locale)}.`)}
  ${clause(`A minor wheel scratch will be charged at
    ${agreed(terms.wheelScratchPence, locale)}. Multiple scratches will be charged at the
    full wheel refurbishment cost.`)}
  ${clause(`A minor scratch will be charged at ${agreed(terms.panelRepairPence, locale)}
    per panel. Larger damage, and any other damage to the exterior or interior, will be
    charged at the full cost of repair or replacement. A punctured tyre that cannot be
    repaired will be charged at the cost of a replacement of the same brand.`)}
  ${clause(`The Hirer must report any claim within 24 hours. Failure to do so may cause
    the insurer to refuse the claim, and any warning light must be reported immediately —
    continuing to drive with one showing makes the Hirer liable for any resulting
    mechanical or electrical damage.`)}
  ${clause(`The vehicle is maintained by the Owner, but it is the Hirer's duty to look
    after it and to check engine oil, brake fluid, coolant, tyre pressures and bulbs
    regularly.`)}
  ${clause(`The Hirer must bring the vehicle to the Owner's designated garage for repairs,
    licensing appointments, testing or any other appointment at the agreed time. Failure
    to attend may incur a cost payable by the Hirer in full.`)}
</ol>

<!-- One block, covering everything above, so the agreement cannot come back
     signed in two places out of three. -->
<div class="execution">
  <p class="declaration">
    The Hirer confirms that they have read and understood this agreement in full,
    including the insurance and liability terms, that it was completed before signature,
    and that they have received a copy.
  </p>
  <div class="signatures">
    <div class="party">
      <div class="role">Signed by the Hirer</div>
      <div class="name">${orDash(hirer.name)}</div>
      <div class="slot"><div class="line"></div><div class="cap">Signature</div></div>
      <div class="slot"><div class="line"></div><div class="cap">Date</div></div>
    </div>
    <div class="party">
      <div class="role">For and on behalf of ${company}</div>
      <div class="name">${data.ownerSignatory ? escapeHtml(data.ownerSignatory) : '&nbsp;'}</div>
      <div class="slot"><div class="line"></div><div class="cap">Signature</div></div>
      <div class="slot"><div class="line"></div><div class="cap">Date</div></div>
    </div>
  </div>
</div>

</body>
</html>`;
}
