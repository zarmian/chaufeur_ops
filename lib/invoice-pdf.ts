import { brandAssetSrc } from './branding';
import { getBranding } from './branding-store';
import { formatDate } from './dates';
import {
  renderInvoiceDocument,
  type InvoiceDocumentData,
} from './invoice-document';
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
        select: { name: true, billingAddress: true, paymentTermsDays: true },
      },
      account: {
        select: { name: true, billingAddress: true, paymentTermsDays: true },
      },
      lines: {
        orderBy: { sortOrder: 'asc' },
        include: {
          job: { select: { reference: true, scheduledAt: true } },
          rental: { select: { reference: true, startAt: true } },
        },
      },
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
    lines: invoice.lines.map((line) => ({
      description: line.description,
      amountPence: line.amountPence,
      reference: line.job?.reference ?? line.rental?.reference ?? null,
      occurredOn: line.job
        ? formatDate(line.job.scheduledAt)
        : line.rental
          ? formatDate(line.rental.startAt)
          : null,
    })),
    netPence: invoice.netPence,
    vatPence: invoice.vatPence,
    grossPence: invoice.grossPence,
    paidPence: invoice.paidPence,
    vatRatePct: Number(invoice.vatRatePct),
    paymentTermsDays: recipient?.paymentTermsDays ?? null,
    notes: invoice.notes,
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
