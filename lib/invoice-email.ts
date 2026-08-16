import { getBranding } from './branding-store';
import { formatDate } from './dates';
import { getEmailConfig } from './email-store';
import { sendEmail, type EmailResult } from './email';
import { absoluteLogoSrc, invoiceDocumentHtml } from './invoice-pdf';
import { escapeHtml } from './invoice-document';
import { getLocaleConfig } from './locale-store';
import { formatMoney } from './money';
import { tryRenderPdf } from './pdf';
import { prisma } from './prisma';

/**
 * Emailing an invoice to whoever is being billed — spec 4.3.9.
 *
 * The PDF is rendered and attached at send time rather than pulled from a
 * stored file. An invoice is immutable once sent, so the two can never
 * disagree — and a draft that was edited after its file was written would
 * otherwise email a version nobody has on screen.
 *
 * Everything here degrades rather than fails. No email provider, no billing
 * address, no headless browser: each returns a refusal the caller can show,
 * and none of them stops the invoice being marked sent. An operator with a
 * PDF and their own mail client is not blocked by this system's mailbox
 * being unconfigured.
 */

export interface InvoiceEmailOutcome {
  attempted: boolean;
  sent: boolean;
  /** Shown to the operator. Says what happened, and what to do instead. */
  message: string;
  recipient: string | null;
}

export async function emailInvoice(
  invoiceId: string,
  options: { requestUrl?: string | null } = {},
): Promise<InvoiceEmailOutcome> {
  const [invoice, config, branding, locale] = await Promise.all([
    prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        number: true,
        grossPence: true,
        dueDate: true,
        client: {
          select: { name: true, billingEmail: true, contactEmail: true },
        },
        account: { select: { name: true, billingEmail: true } },
      },
    }),
    getEmailConfig(),
    getBranding(),
    getLocaleConfig(),
  ]);

  if (!invoice) {
    return {
      attempted: false,
      sent: false,
      message: 'No such invoice',
      recipient: null,
    };
  }

  const recipient =
    invoice.account?.billingEmail ??
    invoice.client?.billingEmail ??
    invoice.client?.contactEmail ??
    null;

  if (config.provider === 'none' || !config.apiKey) {
    return {
      attempted: false,
      sent: false,
      recipient,
      message:
        'Marked as sent. No email provider is configured, so nothing was emailed — download the PDF and send it yourself, or set one up in Settings.',
    };
  }

  if (!recipient) {
    return {
      attempted: false,
      sent: false,
      recipient: null,
      message: `Marked as sent. ${
        invoice.account?.name ?? invoice.client?.name ?? 'The recipient'
      } has no billing email address, so nothing was emailed.`,
    };
  }

  const html = await invoiceDocumentHtml(invoice.id, {
    logoSrc: options.requestUrl ? await absoluteLogoSrc(options.requestUrl) : null,
  });

  if (!html) {
    return {
      attempted: false,
      sent: false,
      recipient,
      message: 'Marked as sent, but the invoice document could not be built.',
    };
  }

  // The footer is also what sets the page margins — the document declares no
  // `@page { margin }`, because a CSS page margin silently overrides the one
  // `page.pdf()` is given. See the note in `app/api/invoices/[id]/pdf`.
  const pdf = await tryRenderPdf(html, { footerText: invoice.number });
  if (!pdf.ok) {
    return {
      attempted: false,
      sent: false,
      recipient,
      // An invoice emailed without its PDF is not an invoice, so this refuses
      // rather than sending a bare covering note.
      message: `Marked as sent, but nothing was emailed: ${pdf.message}`,
    };
  }

  const money = formatMoney(invoice.grossPence, {
    currency: locale.currency,
    locale: locale.locale,
  });

  const result: EmailResult = await sendEmail(config, {
    to: recipient,
    subject: `Invoice ${invoice.number} from ${branding.tradingName}`,
    html: coveringNote({
      tradingName: branding.tradingName,
      recipientName:
        invoice.account?.name ?? invoice.client?.name ?? 'there',
      number: invoice.number,
      total: money,
      dueDate: formatDate(invoice.dueDate),
      supportEmail: branding.supportEmail,
    }),
    text: `Invoice ${invoice.number} for ${money}, due ${formatDate(invoice.dueDate)}. The PDF is attached.`,
    attachments: [
      {
        filename: `${invoice.number}.pdf`,
        content: pdf.pdf,
        contentType: 'application/pdf',
      },
    ],
  });

  if (!result.ok) {
    return {
      attempted: true,
      sent: false,
      recipient,
      message: `Marked as sent, but the email did not go: ${result.message}`,
    };
  }

  return {
    attempted: true,
    sent: true,
    recipient,
    message: `Sent, and emailed to ${recipient}.`,
  };
}

/**
 * The covering note.
 *
 * Short on purpose. The invoice is the attachment; this exists so the email
 * is not a bare attachment with no context, and so the amount and due date
 * are visible without opening anything.
 */
function coveringNote(input: {
  tradingName: string;
  recipientName: string;
  number: string;
  total: string;
  dueDate: string;
  supportEmail: string | null;
}): string {
  return `<!doctype html>
<html lang="en">
<body style="font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;margin:0;padding:24px">
  <p>Dear ${escapeHtml(input.recipientName)},</p>
  <p>
    Invoice <strong>${escapeHtml(input.number)}</strong> is attached, for
    <strong>${escapeHtml(input.total)}</strong>, due
    ${escapeHtml(input.dueDate)}.
  </p>
  <p>
    ${
      input.supportEmail
        ? `Any queries, reply to this message or write to ${escapeHtml(input.supportEmail)}, quoting the invoice number.`
        : 'Any queries, reply to this message quoting the invoice number.'
    }
  </p>
  <p>Thank you,<br />${escapeHtml(input.tradingName)}</p>
</body>
</html>`;
}
