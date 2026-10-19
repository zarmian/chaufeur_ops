import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { nameBoardDocument } from '@/lib/name-board';
import { nameBoardForJob } from '@/lib/name-board-store';
import { tryRenderPdf } from '@/lib/pdf';

/**
 * `GET /api/jobs/:id/name-board` — one board, as a sheet of A4.
 *
 * The paper half of the same board the driver opens on their phone. Both come
 * out of `nameBoardDocument`, so the printed sheet and the screen cannot
 * disagree about what the passenger is called.
 *
 * Landscape, because a name reads at its largest across the long edge — which
 * is also how somebody holds a board.
 *
 * Authenticated, unlike the board itself: this is the office printing, not
 * the driver holding. The unauthenticated route is `/board/:token`, where the
 * token is the credential.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Said to the office, which can act on each of them differently. */
const REFUSALS = {
  'no-name': 'A name board is the passenger\u2019s name, so this job needs one before it can have a board.',
  cancelled: 'This job has been cancelled, so its board has stopped working.',
  'no-job': 'No such job.',
} as const;

export const GET = withErrorHandling(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    await requireCapability('viewJobs');
    const { id } = await context.params;

    /*
     * The same checks the screen board goes through, so the printed sheet and
     * the driver's phone cannot disagree about whether there is a board.
     *
     * The reason comes back with the answer, because this caller is the
     * office and the two reasons call for opposite actions. The message used
     * to say a board "needs an airport transfer with a passenger name on it",
     * which was left behind when the board was widened to every job type —
     * and was worse than merely out of date: it told an operator to relabel
     * the job, which changes how it prices and triples the free waiting
     * allowance.
     */
    const found = await nameBoardForJob(id);

    if (found.state !== 'ok') {
      return new Response(REFUSALS[found.state], {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const { board } = found;

    /*
     * No footer, which is what keeps the margins at zero.
     *
     * `lib/pdf.ts` only supplies page margins when a footer is asked for, and
     * this is the one document that wants none: a name board is the name,
     * edge to edge, and a running footer would both shrink it and put the job
     * reference in front of the passenger it is being held up for.
     */
    const rendered = await tryRenderPdf(nameBoardDocument([board.name], 'print'), {
      landscape: true,
    });

    if (!rendered.ok) {
      // 503 rather than 500: nothing is wrong with the job, and the board is
      // still perfectly usable on screen at /board/:token.
      return new Response(rendered.message, {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response(new Uint8Array(rendered.pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="name-board-${board.reference}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  },
);
