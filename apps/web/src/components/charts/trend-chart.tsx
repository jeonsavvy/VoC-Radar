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
const CHART_HEIGHT = 280;
const PADDING_LEFT = 44;
const PADDING_RIGHT = 16;
const PADDING_TOP = 16;
const PADDING_BOTTOM = 42;

function buildPath(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

export function TrendChart({ data, className }: TrendChartProps) {
  if (data.length === 0) {
    return null;
  }

  const maxTotal = Math.max(...data.map((item) => item.total_reviews), 1);
  const maxCritical = Math.max(...data.map((item) => item.critical_count), 1);
  const stepX = data.length > 1 ? (CHART_WIDTH - PADDING_LEFT - PADDING_RIGHT) / (data.length - 1) : 0;
  const chartHeight = CHART_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  const totalPoints = data.map((item, index) => ({
    x: PADDING_LEFT + stepX * index,
    y: PADDING_TOP + chartHeight - (item.total_reviews / maxTotal) * chartHeight,
  }));

  const criticalPoints = data.map((item, index) => ({
    x: PADDING_LEFT + stepX * index,
    y: PADDING_TOP + chartHeight - (item.critical_count / maxCritical) * chartHeight,
  }));

  const totalPath = buildPath(totalPoints);
  const criticalPath = buildPath(criticalPoints);
  const lastDateLabels = data.filter((_, index) => index === 0 || index === data.length - 1 || index === Math.floor(data.length / 2));

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="size-2 rounded-full bg-primary" />
          전체 리뷰
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-2 rounded-full bg-warning" />
          즉시 확인 필요
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-background p-4">
        <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="w-full" role="img" aria-label="리뷰 추이 차트">
          {[0, 1, 2, 3].map((row) => {
            const y = PADDING_TOP + (chartHeight / 3) * row;
            const value = Math.round(maxTotal - (maxTotal / 3) * row);
            return (
              <g key={row}>
                <line
                  x1={PADDING_LEFT}
                  x2={CHART_WIDTH - PADDING_RIGHT}
                  y1={y}
                  y2={y}
                  stroke="rgb(148 163 184 / 0.25)"
                  strokeDasharray="4 6"
                />
                <text x={8} y={y + 4} fill="rgb(100 116 139)" fontSize="12">
                  {value}
                </text>
              </g>
            );
          })}

          <path d={totalPath} fill="none" stroke="var(--color-primary)" strokeWidth="3" strokeLinecap="round" />
          <path d={criticalPath} fill="none" stroke="var(--color-warning)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="6 6" />

          {totalPoints.map((point, index) => (
            <circle key={data[index]?.bucket_date ?? index} cx={point.x} cy={point.y} r="3" fill="var(--color-primary)" />
          ))}

          {lastDateLabels.map((point) => {
            const index = data.findIndex((item) => item.bucket_date === point.bucket_date);
            const x = PADDING_LEFT + stepX * index;
            return (
              <text key={point.bucket_date} x={x} y={CHART_HEIGHT - 12} textAnchor="middle" fill="rgb(100 116 139)" fontSize="12">
                {new Date(point.bucket_date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
              </text>
            );
          })}
        </svg>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {lastDateLabels.map((item) => (
          <div key={item.bucket_date} className="rounded-xl border border-border bg-panel px-3 py-3 text-sm">
            <p className="text-xs text-muted-foreground">{new Date(item.bucket_date).toLocaleDateString()}</p>
            <p className="mt-1 font-semibold text-foreground">{item.total_reviews.toLocaleString()}건</p>
            <p className="mt-1 text-xs text-muted-foreground">즉시 확인 {item.critical_count.toLocaleString()}건</p>
          </div>
        ))}
      </div>
    </div>
  );
}
