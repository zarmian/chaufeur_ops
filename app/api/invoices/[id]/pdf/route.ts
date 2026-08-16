import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { absoluteLogoSrc, invoiceDocumentHtml } from '@/lib/invoice-pdf';
import { tryRenderPdf } from '@/lib/pdf';

/**
 * `GET /api/invoices/:id/pdf` — spec 4.3.8.
 *
 * Rendered on demand from the stored invoice rather than from a file saved
 * when it was raised. An invoice is immutable once sent, so the two can never
 * disagree — and a draft that is still being edited always prints as it
 * currently stands.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    await requireCapability('viewInvoices');
    const { id } = await context.params;

    const html = await invoiceDocumentHtml(id, {
      logoSrc: await absoluteLogoSrc(request.url),
    });

    if (!html) {
      return new Response('No such invoice', { status: 404 });
    }

    const number = numberFrom(html) ?? id;

    /*
     * The footer is what sets the page margins.
     *
     * The document declares no `@page { margin }` — a CSS page margin silently
     * overrides the one `page.pdf()` is given, which is how body text ends up
     * printing through a running footer. So the margins come from `lib/pdf.ts`,
     * and they only come at all when a footer is asked for.
     *
     * An invoice wants one regardless: a four-page invoice whose later pages
     * carry no number is a document that cannot be shown to be complete.
     */
    const rendered = await tryRenderPdf(html, { footerText: number });
    if (!rendered.ok) {
      // 503 rather than 500: nothing is wrong with the invoice, and the
      // printable version at `/document` works regardless.
      return new Response(rendered.message, {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response(new Uint8Array(rendered.pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${number}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  },
);

/** The invoice number, taken from the document's own title. */
function numberFrom(html: string): string | null {
  const match = /<title>([^<]+)<\/title>/.exec(html);
  const value = match?.[1]?.trim();
  return value && /^[A-Za-z0-9-]+$/.test(value) ? value : null;
}
