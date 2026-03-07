import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DonutChart } from '@/components/charts/donut-chart';
import { MetricCard } from '@/components/metric-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getDashboard } from '@/lib/api';
import type { AppSelection } from '@/lib/appSelection';
import type { DashboardResponse } from '@/types';
import { MessageSquareText, Shapes, Star } from 'lucide-react';

type Props = {
  selection: AppSelection;
};

function getLast30DaysRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function HomePage({ selection }: Props) {
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const { from, to } = getLast30DaysRange();

    setLoading(true);
    setError(null);

    getDashboard(selection.appId, selection.country, from, to)
      .then((response) => {
        if (active) {
          setDashboard(response.data);
        }
      })
      .catch((err) => {
        if (active) {
          setDashboard(null);
          setError(err instanceof Error ? err.message : '리뷰 분석 데이터를 불러오지 못했습니다.');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selection.appId, selection.country]);

  const summary = dashboard?.summary;
  const categories = dashboard?.categories ?? [];
  const issues = dashboard?.issues ?? [];
  const evidence = dashboard?.evidence ?? [];

  const categorySummaryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues) {
      if (!map.has(issue.category) && issue.reason_summary) {
        map.set(issue.category, issue.reason_summary);
      }
    }
    return map;
  }, [issues]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Card key={index}>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-4 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error ? (
        <Card className="border-destructive/30">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <MetricCard label="리뷰 수" value={summary ? summary.total_reviews.toLocaleString() : '0'} hint="최근 30일" icon={MessageSquareText} />
        <MetricCard label="유형 수" value={categories.length.toLocaleString()} hint="분류된 유형 기준" icon={Shapes} />
        <MetricCard label="평균 평점" value={summary ? summary.average_rating.toFixed(2) : '0.00'} hint="최근 30일 평균" icon={Star} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.45fr_0.95fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">유형 요약</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-3">유형</th>
                    <th className="px-3 py-3">리뷰 수</th>
                    <th className="px-3 py-3">비중</th>
                    <th className="px-3 py-3">대표 요약</th>
                  </tr>
                </thead>
                <tbody>
                  {categories.length > 0 ? (
                    categories.map((category) => (
                      <tr
                        key={category.category}
                        className="cursor-pointer border-b border-border/80 transition-colors hover:bg-accent/60"
                        onClick={() => navigate(`/reviews?category=${encodeURIComponent(category.category)}`)}
                      >
                        <td className="px-3 py-3">
                          <Badge variant="outline">{category.category}</Badge>
                        </td>
                        <td className="px-3 py-3 font-semibold text-foreground">{category.total_reviews.toLocaleString()}</td>
                        <td className="px-3 py-3 text-foreground">{category.share_percent.toFixed(1)}%</td>
                        <td className="px-3 py-3 text-muted-foreground">{categorySummaryMap.get(category.category) || '-'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="px-3 py-10 text-center text-muted-foreground">
                        표시할 유형이 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">유형 분포</CardTitle>
          </CardHeader>
          <CardContent>
            {categories.length > 0 ? (
              <DonutChart data={categories.map((item) => ({ label: item.category, value: item.total_reviews }))} />
            ) : (
              <p className="text-sm text-muted-foreground">분포 데이터가 없습니다.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-end justify-between gap-3">
            <CardTitle className="text-xl">대표 리뷰</CardTitle>
            <Button asChild variant="outline">
              <Link to="/reviews">전체 보기</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {evidence.length > 0 ? (
            evidence.map((item) => (
              <button
                key={item.review_id}
                type="button"
                onClick={() => navigate(`/reviews?category=${encodeURIComponent(item.category)}`)}
                className="rounded-xl border border-border bg-panel p-4 text-left transition-colors hover:bg-accent/60"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{item.category}</Badge>
                  <Badge variant={item.priority === 'Critical' ? 'destructive' : item.priority === 'High' ? 'warning' : 'secondary'}>
                    {item.priority}
                  </Badge>
                </div>
                <p className="mt-3 text-sm font-semibold text-foreground">{item.summary}</p>
                <p className="mt-2 line-clamp-4 text-sm text-muted-foreground">{item.content}</p>
              </button>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">표시할 리뷰가 없습니다.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
