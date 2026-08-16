import { brandAssetSrc } from './branding';
import { getBranding } from './branding-store';
import { formatDate } from './dates';
import {
  renderInvoiceDocument,
  type InvoiceDocumentData,
} from './invoice-document';
import { splitLineText } from './invoice-lines';
import { getLocaleConfig } from './locale-store';
import { prisma } from './prisma';

/**
 * Gathering an invoice into the shape the printed document wants.
 *
 * Separate from `lib/invoice-document.ts` on purpose: the template is pure and
 * testable, and this is the part that talks to Postgres and to settings.
 */
export async function invoiceDocumentHtml(
  invoiceId: string,
  options: { logoSrc?: string | null } = {},
): Promise<string | null> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      client: {
        select: {
          name: true,
          billingAddress: true,
          billingEmail: true,
          contactEmail: true,
          paymentTermsDays: true,
        },
      },
      account: {
        select: {
          name: true,
          billingAddress: true,
          billingEmail: true,
          contactEmail: true,
          paymentTermsDays: true,
        },
      },
      lines: { orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!invoice) return null;

  const [branding, locale] = await Promise.all([
    getBranding(),
    getLocaleConfig(),
  ]);

  const recipient = invoice.account ?? invoice.client;

  const data: InvoiceDocumentData = {
    number: invoice.number,
    issueDate: formatDate(invoice.issueDate),
    dueDate: formatDate(invoice.dueDate),
    status: invoice.status,
    isCreditNote: Boolean(invoice.creditsInvoiceId),
    recipientName: recipient?.name ?? 'No recipient recorded',
    recipientAddress: recipient?.billingAddress ?? null,
    recipientEmail: recipient?.billingEmail ?? recipient?.contactEmail ?? null,
    lines: invoice.lines.map((line) => {
      const { title, details } = splitLineText(line.description);
      return {
        title,
        details,
        amountPence: line.amountPence,
        disbursementPence: line.disbursementPence,
        vatTreatment: line.vatTreatment,
        quantity:
          line.quantity === null ? null : Number(line.quantity.toString()),
        quantityUnit: line.quantityUnit,
        unitPricePence: line.unitPricePence,
      };
    }),
    netPence: invoice.netPence,
    vatPence: invoice.vatPence,
    grossPence: invoice.grossPence,
    paidPence: invoice.paidPence,
    vatRatePct: Number(invoice.vatRatePct),
    paymentTermsDays: recipient?.paymentTermsDays ?? null,
    notes: invoice.notes,
    // Who signs. From settings, so the name on the paperwork changes when the
    // director does rather than when somebody edits a template.
    signatory: branding.invoiceSignatory,
  };

  return renderInvoiceDocument(data, {
    branding,
    locale,
    logoSrc: options.logoSrc ?? null,
  });
}

/**
 * The logo as a URL something outside the app can fetch.
 *
 * A PDF renderer loading this page has no notion of the application's origin,
 * so the app-relative `/api/branding/asset` src that works in the browser
 * would simply not resolve. Resolved against the incoming request rather than
 * a configured base URL, so preview deployments and custom domains work
 * without another setting to keep in step.
 */
export async function absoluteLogoSrc(requestUrl: string): Promise<string | null> {
  const branding = await getBranding();
  const src = brandAssetSrc('logoLightUrl', branding.logoLightUrl);
  if (!src) return null;
  return src.startsWith('/') ? new URL(src, requestUrl).toString() : src;
}
