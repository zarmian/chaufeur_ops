import { roundPence, sumPence } from './money';

/**
 * How much tax an invoice carries, line by line.
 *
 * Three things had to be modelled that a single invoice-wide rate cannot.
 *
 * **Not every job is tax-qualifying.** Some work is charged with tax added on
 * top, some is charged at a price that already includes it, and some carries
 * none at all. A single `vatRatePct` on the invoice header forced all three
 * into whichever one the operator picked, and the other two came out wrong —
 * either the client was charged 20% they had already paid, or the company
 * quietly absorbed 20% it had not.
 *
 * **Disbursements are never taxed.** A car park fee or an airport drop-off
 * charge is money paid on the client's behalf and passed straight through. It
 * belongs on the invoice — the client owes it — but adding tax to it invents
 * tax on somebody else's supply. So each line carries the pass-through part
 * separately, and it is excluded from the base every time.
 *
 * **The document has to agree with itself.** Within a treatment, tax is worked
 * out on the group's total rather than per line and summed: twenty lines of
 * £10.99 at 20% round to £2.20 each, £44.00 in all, where the right figure on
 * £219.80 is £43.96. Either is acceptable to a tax authority; only one
 * survives somebody adding the column up. Grouping keeps that property while
 * letting the treatments differ.
 *
 * Pure. No database, no settings lookup, no `Date.now()`.
 */

export type VatTreatment = 'STANDARD' | 'INCLUSIVE' | 'EXEMPT';

/**
 * The label an operator picks from, and what it means for the money.
 *
 * Worded around the price rather than around tax law, because the question
 * being answered at the keyboard is "what did we agree to charge them" — the
 * arithmetic follows from that, not the other way round.
 */
export const VAT_TREATMENTS = [
  {
    value: 'STANDARD',
    label: 'Added on top',
    description: 'The agreed price is before tax. Tax is added to it.',
  },
  {
    value: 'INCLUSIVE',
    label: 'Included in the price',
    description: 'The agreed price already contains tax. It is shown separately.',
  },
  {
    value: 'EXEMPT',
    label: 'No tax',
    description: 'The work is not tax-qualifying. Nothing is added.',
  },
] as const;

export const DEFAULT_VAT_TREATMENT: VatTreatment = 'STANDARD';

export function vatTreatmentLabel(treatment: VatTreatment): string {
  return (
    VAT_TREATMENTS.find((option) => option.value === treatment)?.label ??
    treatment
  );
}

/** A line as it arrives: what is charged, and how much of that passes through. */
export interface TaxableLine {
  /**
   * The whole charge for the line as it was agreed and as it is shown.
   *
   * Under `STANDARD` this is before tax; under `INCLUSIVE` it already contains
   * it. Both are "the number on the line", which is what an operator edits.
   */
  amountPence: number;
  /**
   * The part of `amountPence` that is a pass-through — parking, a drop-off
   * charge, a toll. Never taxed, under any treatment.
   */
  disbursementPence?: number | null;
  treatment: VatTreatment;
}

export interface LineTax {
  /** The taxable part of the charge, after any inclusive tax is backed out. */
  netPence: number;
  /** Untaxed pass-through, carried through untouched. */
  disbursementPence: number;
  taxPence: number;
  /** What the client pays for this line. */
  grossPence: number;
}

export interface TaxBand {
  treatment: VatTreatment;
  ratePct: number;
  netPence: number;
  disbursementPence: number;
  taxPence: number;
}

export interface InvoiceTax {
  /** Everything the tax was worked out on, plus untaxed pass-throughs. */
  netPence: number;
  taxPence: number;
  grossPence: number;
  /** Pass-through charges, totalled. Shown so a client can see them. */
  disbursementPence: number;
  /** One entry per treatment actually used, in a stable order. */
  bands: TaxBand[];
}

/** The order bands print in: taxed first, then inclusive, then untaxed. */
const BAND_ORDER: VatTreatment[] = ['STANDARD', 'INCLUSIVE', 'EXEMPT'];

/**
 * Tax for one line, given the rate.
 *
 * Used for the per-line figures a document shows. The invoice's own totals
 * come from `invoiceTax`, which groups first — see the note at the top of this
 * file about why the two can differ by a penny and which one wins.
 */
export function lineTax(line: TaxableLine, ratePct: number): LineTax {
  const disbursementPence = line.disbursementPence ?? 0;
  const farePence = line.amountPence - disbursementPence;

  if (line.treatment === 'EXEMPT') {
    return {
      netPence: farePence,
      disbursementPence,
      taxPence: 0,
      grossPence: line.amountPence,
    };
  }

  if (line.treatment === 'INCLUSIVE') {
    const net = backOutTax(farePence, ratePct);
    return {
      netPence: net,
      disbursementPence,
      taxPence: farePence - net,
      // Nothing is added: the price already contained it.
      grossPence: line.amountPence,
    };
  }

  const taxPence = roundPence((farePence * ratePct) / 100);
  return {
    netPence: farePence,
    disbursementPence,
    taxPence,
    grossPence: line.amountPence + taxPence,
  };
}

/**
 * The net hiding inside a tax-inclusive price.
 *
 * `net = gross / (1 + rate)`. Rounded once, here, so a credit note reversing
 * an inclusive line lands on exactly the same penny — `roundPence` is
 * half-away-from-zero, which is why negating the input negates the output.
 */
export function backOutTax(grossPence: number, ratePct: number): number {
  if (ratePct === 0) return grossPence;
  return roundPence(grossPence / (1 + ratePct / 100));
}

/**
 * Net, tax and gross for a whole invoice.
 *
 * Lines are grouped by treatment and the tax worked out once per group, so the
 * printed total is the one you get by adding up the printed bands.
 */
export function invoiceTax(lines: TaxableLine[], ratePct: number): InvoiceTax {
  const bands: TaxBand[] = [];

  for (const treatment of BAND_ORDER) {
    const group = lines.filter((line) => line.treatment === treatment);
    if (group.length === 0) continue;

    const disbursementPence = sumPence(
      ...group.map((line) => line.disbursementPence ?? 0),
    );
    const farePence =
      sumPence(...group.map((line) => line.amountPence)) - disbursementPence;

    if (treatment === 'EXEMPT') {
      bands.push({
        treatment,
        ratePct: 0,
        netPence: farePence,
        disbursementPence,
        taxPence: 0,
      });
      continue;
    }

    if (treatment === 'INCLUSIVE') {
      const net = backOutTax(farePence, ratePct);
      bands.push({
        treatment,
        ratePct,
        netPence: net,
        disbursementPence,
        taxPence: farePence - net,
      });
      continue;
    }

    bands.push({
      treatment,
      ratePct,
      netPence: farePence,
      disbursementPence,
      taxPence: roundPence((farePence * ratePct) / 100),
    });
  }

  const netPence = sumPence(
    ...bands.map((band) => band.netPence + band.disbursementPence),
  );
  const taxPence = sumPence(...bands.map((band) => band.taxPence));

  return {
    netPence,
    taxPence,
    grossPence: netPence + taxPence,
    disbursementPence: sumPence(...bands.map((band) => band.disbursementPence)),
    bands,
  };
}

/**
 * Charges that are passed through rather than supplied.
 *
 * The operator pays a car park, an airport drop-off barrier or a toll on the
 * client's behalf and recharges it at cost. The supply is the car park's, not
 * the operator's, so no tax of the operator's is due on it — which is what the
 * customer meant by "if tax is charged, it is not charged on parking charges
 * and drop-off charges".
 *
 * `FUEL` is deliberately absent: fuel bought to run the job is a cost of the
 * operator's own supply, not something bought for the client. So is `WAITING`,
 * which is time — the most taxable thing on the invoice.
 */
export const DISBURSEMENT_KINDS = [
  'PARKING',
  'DROPOFF_CHARGE',
  'TOLL',
  'CONGESTION_CHARGE',
  'ULEZ',
] as const;

export type DisbursementKind = (typeof DISBURSEMENT_KINDS)[number];

export function isDisbursementKind(kind: string): kind is DisbursementKind {
  return (DISBURSEMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * How much of a job's recharged expenses is pass-through.
 *
 * Only expenses the client is actually being charged for count — one the
 * company or the driver bears never reaches the invoice, so subtracting it
 * from the tax base would shrink the base by money the client was never asked
 * for.
 */
export function disbursementPenceOf(
  expenses: Array<{ kind: string; amountPence: number; borneBy: string }>,
): number {
  return sumPence(
    ...expenses
      .filter(
        (expense) =>
          expense.borneBy === 'CLIENT' && isDisbursementKind(expense.kind),
      )
      .map((expense) => expense.amountPence),
  );
}

/**
 * The treatment to use for a piece of work.
 *
 * The job's own answer wins, then the account or client it is billed to, then
 * the install's default. Nulls all the way down means nobody has said, and
 * "added on top" is the safe assumption: undercharging tax is the company's
 * loss, and it is the one an accountant discovers late.
 */
export function resolveVatTreatment(
  ...candidates: Array<VatTreatment | null | undefined>
): VatTreatment {
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return DEFAULT_VAT_TREATMENT;
}
