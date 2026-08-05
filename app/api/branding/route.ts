import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { brandingSchema } from '@/lib/branding';
import { saveBranding, saveBrandingAsset } from '@/lib/branding-store';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';
import {
  assertBrandAssetUploadable,
  buildObjectKey,
  isStorageConfigured,
  uploadBrandAsset,
} from '@/lib/storage';

/**
 * `POST /api/branding` — save the company's identity.
 *
 * A plain form post to a route handler, for the reason documented in
 * `app/api/jobs/[id]/status/route.ts`: a Server Action submitted while the
 * page is still hydrating commits the write and has its redirect discarded.
 *
 * Assets are handled in the same request as the text fields, so uploading a
 * logo and renaming the company is one save rather than two.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ASSET_FIELDS = ['logoLightUrl', 'logoDarkUrl', 'faviconUrl'] as const;
type AssetField = (typeof ASSET_FIELDS)[number];

/** The typed-link input that corresponds to each uploadable asset. */
const LINK_FIELD: Record<AssetField, string> = {
  logoLightUrl: 'logoLightLink',
  logoDarkUrl: 'logoDarkLink',
  faviconUrl: 'faviconLink',
};

export async function POST(request: Request) {
  const query = new URLSearchParams();

  try {
    const user = await requireCapability('manageSettings');
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };
    const form = await request.formData();

    await saveBranding(
      brandingSchema.parse({
        tradingName: form.get('tradingName') ?? '',
        legalName: form.get('legalName') ?? '',
        primaryColour: form.get('primaryColour') ?? '',
        accentColour: form.get('accentColour') ?? '',
        addressLines: form.get('addressLines') ?? '',
        phone: form.get('phone') ?? '',
        supportEmail: form.get('supportEmail') ?? '',
        websiteUrl: form.get('websiteUrl') ?? '',
        taxNumber: form.get('taxNumber') ?? '',
        companyNumber: form.get('companyNumber') ?? '',
        bankDetails: form.get('bankDetails') ?? '',
        jobReferencePrefix: form.get('jobReferencePrefix') ?? 'JOB',
        invoiceNumberPrefix: form.get('invoiceNumberPrefix') ?? 'INV',
        logoLightLink: form.get('logoLightLink') ?? '',
        logoDarkLink: form.get('logoDarkLink') ?? '',
        faviconLink: form.get('faviconLink') ?? '',
      }),
      audit,
    );

    for (const field of ASSET_FIELDS) {
      // A tick-box, so removing a logo does not mean uploading a blank one.
      if (form.get(`${field}Clear`) === 'on') {
        await saveBrandingAsset(field, null, audit);
        continue;
      }

      // A typed link wins over an upload in the same submission — somebody
      // filling in the address is choosing it over whatever is stored, and
      // this is the only route open to a deployment without a Blob store.
      const link = String(form.get(LINK_FIELD[field]) ?? '').trim();
      if (link !== '') {
        await saveBrandingAsset(field, link, audit);
        continue;
      }

      const file = form.get(field);
      if (!(file instanceof File) || file.size === 0) continue;

      if (!isStorageConfigured()) {
        query.set(
          'brandingError',
          'File storage is not configured, so the logo could not be saved. The rest of the branding was.',
        );
        continue;
      }

      // SVG is accepted here and nowhere else — see `BRAND_MIME_TYPES`. The
      // size ceiling is the same as for any other upload.
      assertBrandAssetUploadable(file);
      const key = buildObjectKey('brand', field, file.name, 'branding');
      await uploadBrandAsset(
        Buffer.from(await file.arrayBuffer()),
        key,
        file.type,
      );
      await saveBrandingAsset(field as AssetField, key, audit);
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'brandingError',
      error instanceof Error ? error.message.slice(0, 300) : 'That could not be saved',
    );
  }

  if (!query.has('brandingError')) query.set('updated', String(Date.now()));

  // Relative, so a resolved absolute URL cannot cross origins and drop the
  // session cookie — see `app/api/jobs/[id]/status/route.ts`.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/branding?${query.toString()}` },
  });
}
