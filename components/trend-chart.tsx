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

  const vertices = points.map((point, index) => ({
    x: index * (width / points.length) + barWidth / 2 + BAR_GAP / 2,
    y: y(point.profitPence),
  }));

  const line = vertices
    .map(
      (vertex, index) =>
        `${index === 0 ? 'M' : 'L'}${vertex.x.toFixed(1)},${vertex.y.toFixed(1)}`,
    )
    .join(' ');

  /**
   * How long the profit line is, in user units.
   *
   * Needed to draw it on with `stroke-dashoffset`, and computed here rather
   * than measured with `getTotalLength()` because this is a Server Component
   * and there is no DOM to ask. It is exact rather than an estimate: the path
   * is straight segments, so the sum of the segment lengths *is* its length.
   */
  const lineLength = vertices.reduce((total, vertex, index) => {
    if (index === 0) return 0;
    const previous = vertices[index - 1]!;
    return total + Math.hypot(vertex.x - previous.x, vertex.y - previous.y);
  }, 0);

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
            <g
              key={point.month}
              role="img"
              aria-label={`${point.month}: ${formatGBP(point.revenuePence)} revenue, ${formatGBP(point.profitPence)} profit, ${point.jobs} jobs`}
            >
              {/* An `aria-label`, and deliberately not an SVG <title>.

                  A <title> here is the obvious way to get a hover tooltip and
                  it cannot be used: React validates DOM nesting by HTML rules
                  even inside an <svg>, and in HTML a <title> may only live in
                  <head>. One anywhere in this chart fails hydration with
                  React error #418 on every page that carries it — which, now
                  the dashboard has a chart, is the two screens people open
                  most. Moving it from the <rect> to the <g> does not help;
                  only removing it does.

                  So the figures are announced rather than hovered. The cost
                  is the mouse tooltip; the gain is that the page hydrates,
                  and the numbers are still on the page in the tiles and the
                  reports the chart links to. */}
              <rect
                x={x}
                y={top}
                width={barWidth}
                height={Math.max(HEIGHT - top, 1)}
                rx={2}
                className="animate-grow-up fill-primary/25"
                style={{
                  // Out of the axis, not out of thin air: without an origin
                  // the bar scales about its own middle and grows downwards
                  // through the baseline as well as up from it.
                  transformOrigin: `0 ${HEIGHT}px`,
                  // Left to right, a month at a time, so the eye reads the
                  // series in the order it happened rather than seeing twelve
                  // bars arrive at once. Small enough that the whole chart is
                  // settled well inside a second.
                  animationDelay: `${index * 35}ms`,
                }}
              />
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

        {/* The profit line arrives after the bars it runs across, so the
            chart reads as "here is the revenue — and here is what was left of
            it" rather than as everything appearing at once. */}
        <path
          d={line}
          fill="none"
          className="animate-draw-in stroke-primary"
          strokeWidth={2}
          strokeDasharray={lineLength}
          style={
            {
              '--draw-length': lineLength,
              animationDelay: `${points.length * 35}ms`,
            } as React.CSSProperties
          }
        />
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
