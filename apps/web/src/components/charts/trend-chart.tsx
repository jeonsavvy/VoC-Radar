import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface TrendPoint {
  bucket_date: string;
  total_reviews: number;
  critical_count: number;
  average_rating: number;
}

interface TrendChartProps {
  data: TrendPoint[];
  className?: string;
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 260;
const PADDING_X = 20;
const PADDING_Y = 26;

function normalizeSeries(data: TrendPoint[]) {
  if (data.length === 0) {
    return { totalMax: 1, criticalMax: 1 };
  }

  return {
    totalMax: Math.max(...data.map((item) => item.total_reviews), 1),
    criticalMax: Math.max(...data.map((item) => item.critical_count), 1),
  };
}

function buildPath(points: Array<{ x: number; y: number }>) {
  return points.reduce((path, point, index) => `${path}${index === 0 ? 'M' : 'L'} ${point.x} ${point.y} `, '').trim();
}

function buildArea(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) {
    return '';
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return '';
  }

  return `${buildPath(points)} L ${last.x} ${CHART_HEIGHT - PADDING_Y} L ${first.x} ${CHART_HEIGHT - PADDING_Y} Z`;
}

export function TrendChart({ data, className }: TrendChartProps) {
  const { totalMax, criticalMax } = normalizeSeries(data);
  const horizontalStep = data.length > 1 ? (CHART_WIDTH - PADDING_X * 2) / (data.length - 1) : 0;

  const totalPoints = data.map((item, index) => ({
    x: PADDING_X + horizontalStep * index,
    y: CHART_HEIGHT - PADDING_Y - (item.total_reviews / totalMax) * (CHART_HEIGHT - PADDING_Y * 2),
  }));

  const criticalPoints = data.map((item, index) => ({
    x: PADDING_X + horizontalStep * index,
    y: CHART_HEIGHT - PADDING_Y - (item.critical_count / criticalMax) * (CHART_HEIGHT - PADDING_Y * 2),
  }));

  const totalPath = buildPath(totalPoints);
  const totalArea = buildArea(totalPoints);
  const criticalPath = buildPath(criticalPoints);

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-center gap-5 text-xs uppercase tracking-[0.22em] text-muted-foreground">
        <span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-primary" />Total reviews</span>
        <span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-warning" />Critical</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/40 p-3">
        <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="w-full">
          <defs>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {[0, 1, 2, 3].map((row) => {
            const y = PADDING_Y + ((CHART_HEIGHT - PADDING_Y * 2) / 3) * row;
            return <line key={row} x1={PADDING_X} x2={CHART_WIDTH - PADDING_X} y1={y} y2={y} stroke="rgb(148 163 184 / 0.15)" strokeDasharray="4 10" />;
          })}

          <motion.path
            d={totalArea}
            fill="url(#trend-fill)"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35 }}
          />
          <motion.path
            d={totalPath}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth="3"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          />
          <motion.path
            d={criticalPath}
            fill="none"
            stroke="var(--color-warning)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray="8 8"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.55, delay: 0.1, ease: 'easeOut' }}
          />

          {totalPoints.map((point, index) => (
            <g key={data[index]?.bucket_date ?? index}>
              <circle cx={point.x} cy={point.y} r="3.5" fill="var(--color-primary)" />
            </g>
          ))}
        </svg>
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
        {data.slice(Math.max(0, data.length - 4)).map((point) => (
          <div key={point.bucket_date} className="rounded-xl border border-border/70 bg-background/40 px-3 py-2">
            <p>{new Date(point.bucket_date).toLocaleDateString()}</p>
            <p className="mt-1 font-mono text-sm text-foreground">{point.total_reviews.toLocaleString()} / {point.critical_count.toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
