import { formatGBP } from '@/lib/money';

/**
 * Revenue and profit, month by month — spec 4.6.5.
 *
 * Inline SVG rather than a charting library. It is a bar per month and a line
 * across them; pulling in a dependency for that would be a lot of bundle to
 * carry for one screen, and this renders on the server with no hydration at
 * all.
 *
 * Colours come from Tailwind's brand-driven classes, never from hex literals
 * — the CI check that forbids them in component code is there so a white-label
 * install's palette actually reaches every part of the UI.
 */

export interface TrendPoint {
  month: string;
  jobs: number;
  revenuePence: number;
  profitPence: number;
}

const HEIGHT = 160;
const BAR_GAP = 6;

export function TrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Nothing in this range to chart.
      </p>
    );
  }

  // Scaled to the tallest bar, including a loss-making month: a profit line
  // that ran off the bottom of the axis would hide the very month worth
  // looking at.
  const ceiling = Math.max(
    ...points.map((point) => Math.max(point.revenuePence, point.profitPence)),
    1,
  );
  const floor = Math.min(...points.map((point) => point.profitPence), 0);
  const span = ceiling - floor || 1;

  const width = Math.max(points.length * 56, 320);
  const barWidth = width / points.length - BAR_GAP;
  const y = (pence: number) => HEIGHT - ((pence - floor) / span) * HEIGHT;

  const line = points
    .map((point, index) => {
      const x = index * (width / points.length) + barWidth / 2 + BAR_GAP / 2;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y(point.profitPence).toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT + 28}`}
        className="h-56 w-full min-w-80"
        role="img"
        aria-label={`Revenue and profit by month, ${points[0]?.month} to ${points[points.length - 1]?.month}`}
      >
        {/* Zero line, drawn only when something dipped below it — otherwise
            it sits on the axis and adds nothing. */}
        {floor < 0 ? (
          <line
            x1={0}
            x2={width}
            y1={y(0)}
            y2={y(0)}
            className="stroke-border"
            strokeDasharray="3 3"
          />
        ) : null}

        {points.map((point, index) => {
          const x = index * (width / points.length) + BAR_GAP / 2;
          const top = y(point.revenuePence);
          return (
            <g key={point.month}>
              <rect
                x={x}
                y={top}
                width={barWidth}
                height={Math.max(HEIGHT - top, 1)}
                rx={2}
                className="fill-primary/25"
              >
                <title>
                  {point.month}: {formatGBP(point.revenuePence)} revenue,{' '}
                  {formatGBP(point.profitPence)} profit, {point.jobs} jobs
                </title>
              </rect>
              <text
                x={x + barWidth / 2}
                y={HEIGHT + 18}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {point.month.slice(5)}
              </text>
            </g>
          );
        })}

        <path d={line} fill="none" className="stroke-primary" strokeWidth={2} />
      </svg>

      <div className="mt-1 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-primary/25" />
          Revenue
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-primary" />
          Gross profit
        </span>
      </div>
    </div>
  );
}
