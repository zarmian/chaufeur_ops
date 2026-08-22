import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { nameBoardDocument } from '@/lib/name-board';
import { nameBoardsForDay } from '@/lib/name-board-store';
import { tryRenderPdf } from '@/lib/pdf';

/**
 * `GET /api/dispatch/name-boards?day=YYYY-MM-DD` — the day's boards, as one
 * stack.
 *
 * What an office actually does at six in the morning: print the lot, in the
 * order the cars go out, and hand each driver theirs. Eleven separate
 * downloads is the version of this that nobody uses twice.
 *
 * One page per board — `break-after: page` in the document does the dividing,
 * so the same markup that fills a phone screen fills a sheet.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = withErrorHandling(async (request: Request) => {
  await requireCapability('viewJobs');

  const day = parseDay(new URL(request.url).searchParams.get('day'));
  const boards = await nameBoardsForDay(day);

  if (boards.length === 0) {
    // 404 rather than an empty PDF: a nought-page document downloads happily
    // and then opens as nothing, which reads as a broken feature rather than
    // as a day with no airport work on it.
    return new Response('No airport transfers with a passenger name that day.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const rendered = await tryRenderPdf(
    nameBoardDocument(
      boards.map((board) => board.name),
      'print',
    ),
    { landscape: true },
  );

  if (!rendered.ok) {
    return new Response(rendered.message, {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(new Uint8Array(rendered.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="name-boards-${isoDay(day)}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
});

/** `YYYY-MM-DD` from the query, or today. Midday, to survive a DST edge. */
function parseDay(value: string | null): Date {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T12:00:00.000Z`);
  }
  return new Date();
}

function isoDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}
