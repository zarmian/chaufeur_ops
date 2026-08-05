import { withErrorHandling, apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { buildTemplate } from '@/lib/import';
import { isImportEntity } from '@/lib/import-schema';

/**
 * `GET /api/import/template?entity=drivers` — the blank file to fill in.
 *
 * Correct headers and one example row, so the format of every column is
 * unambiguous. `lib/import.integration.test.ts` imports each template back
 * through the validator: a template whose own example row fails is worse than
 * no template at all.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (request: Request): Promise<Response> => {
  await requireCapability('manageSettings');

  const entity = new URL(request.url).searchParams.get('entity') ?? '';
  if (!isImportEntity(entity)) {
    return apiError('VALIDATION_FAILED', 'Unknown import type');
  }

  return new Response(buildTemplate(entity), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${entity}-template.csv"`,
    },
  });
});
