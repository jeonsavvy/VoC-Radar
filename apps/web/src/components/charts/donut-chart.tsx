import { cn } from '@/lib/utils';

interface DonutChartItem {
  label: string;
  value: number;
}

interface DonutChartProps {
  data: DonutChartItem[];
  className?: string;
}

const COLORS = ['#2563eb', '#0f766e', '#d97706', '#7c3aed', '#64748b'];

export function DonutChart({ data, className }: DonutChartProps) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const radius = 66;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;

  return (
    <div className={cn('grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]', className)}>
      <div className="flex items-center justify-center">
        <svg viewBox="0 0 180 180" className="size-44" role="img" aria-label="유형 분포 원형 차트">
          <circle cx="90" cy="90" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="20" />
          {data.map((item, index) => {
            const segment = total > 0 ? (item.value / total) * circumference : 0;
            const currentOffset = offset;
            offset += segment;

            return (
              <circle
                key={item.label}
                cx="90"
                cy="90"
                r={radius}
                fill="none"
                stroke={COLORS[index % COLORS.length]}
                strokeWidth="20"
                strokeDasharray={`${segment} ${circumference - segment}`}
                strokeDashoffset={-currentOffset}
                strokeLinecap="butt"
                transform="rotate(-90 90 90)"
              />
            );
          })}
          <text x="90" y="84" textAnchor="middle" fontSize="13" fill="#64748b">
            전체 리뷰
          </text>
          <text x="90" y="105" textAnchor="middle" fontSize="24" fontWeight="700" fill="#0f172a">
            {total}
          </text>
        </svg>
      </div>

      <div className="space-y-3">
        {data.map((item, index) => {
          const ratio = total > 0 ? (item.value / total) * 100 : 0;
          return (
            <div key={item.label} className="rounded-xl border border-border bg-panel px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="size-3 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                  <p className="text-sm font-semibold text-foreground">{item.label}</p>
                </div>
                <p className="text-sm font-semibold text-foreground">{ratio.toFixed(1)}%</p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{item.value.toLocaleString()}건</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
