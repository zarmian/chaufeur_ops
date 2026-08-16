import { withErrorHandling } from '@/lib/api';
import { getBranding } from '@/lib/branding-store';
import { requireCapability } from '@/lib/authz';
import { absoluteLogoSrc } from '@/lib/invoice-pdf';
import { markContractGenerated, rentalContractHtml } from '@/lib/rental-contract-pdf';
import { tryRenderPdf } from '@/lib/pdf';

/**
 * `GET /api/rentals/:id/contract` — the hire agreement.
 *
 * One document containing all three parts an operator sends: the contract of
 * hire, the acceptance of vehicle liability and the terms and conditions.
 * Three attachments is three chances for a renter to sign two of them.
 *
 * `?format=html` returns the markup instead, so the wording can be checked
 * before it goes out and printed from the browser on a deployment where
 * headless Chromium is unavailable.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    // Rentals are operational, so OPS raises its own contracts.
    await requireCapability('editVehicles');
    const { id } = await context.params;

    const html = await rentalContractHtml(id, { logoSrc: await absoluteLogoSrc(request.url) });
    if (!html) {
      return new Response('That rental no longer exists', { status: 404 });
    }

    const url = new URL(request.url);
    if (url.searchParams.get('format') === 'html') {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // Chromium's own footer, which reserves a margin — a footer inside the
    // document would have body text running underneath it.
    const pdf = await tryRenderPdf(html, {
      footerText: `Vehicle hire agreement · ${(await getBranding()).tradingName}`,
    });
    if (!pdf.ok) {
      // The markup is the same either way, so a browser that cannot render a
      // PDF here can still print one.
      return new Response(pdf.message, { status: 503 });
    }

    await markContractGenerated(id);

    return new Response(new Uint8Array(pdf.pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="hire-agreement-${id}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  },
);
