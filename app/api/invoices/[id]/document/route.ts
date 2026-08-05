import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { absoluteLogoSrc, invoiceDocumentHtml } from '@/lib/invoice-pdf';

/**
 * `GET /api/invoices/:id/document` — the invoice as a printable page.
 *
 * The same markup the PDF is rendered from, served on its own so an operator
 * can look at what a client will receive before sending it, and print it from
 * the browser on a deployment where headless Chromium is not available.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  },
);
