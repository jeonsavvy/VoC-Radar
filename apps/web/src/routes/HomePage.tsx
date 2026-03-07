import { useEffect, useState } from 'react';
import { ArrowRight, Clock3, MessageSquareText, Star, TriangleAlert } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { DonutChart } from '@/components/charts/donut-chart';
import { MetricCard } from '@/components/metric-card';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getDashboard } from '@/lib/api';
import type { AppSelection } from '@/lib/appSelection';
import type { DashboardResponse } from '@/types';

type Props = {
  selection: AppSelection;
};

function getLast30DaysRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: from.toISOString(), to: to.toISOString() };
}

function formatIssueDelta(value: number | null) {
  if (value == null) {
    return '-';
  }

  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
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
  const issues = dashboard?.issues ?? [];
  const categories = dashboard?.categories ?? [];
  const evidence = dashboard?.evidence ?? [];
  const runs = dashboard?.runs ?? [];

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="대시보드"
          title="최근 30일 App Store 리뷰를 불러오는 중입니다."
          description="리뷰 수, 주요 이슈, 유형 분포를 정리하고 있습니다."
          status="로딩 중"
        />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
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
      <PageHeader
        eyebrow="대시보드"
        title={`${summary?.app_name || `앱 ${selection.appId}`} 리뷰 분석`}
        description="최근 30일 App Store 리뷰 기준으로 리뷰 수, 주요 이슈, 유형 분포를 요약했습니다."
        status={summary?.last_published_at ? `마지막 반영 ${new Date(summary.last_published_at).toLocaleString()}` : '최근 30일 기준'}
        meta={`${selection.appId} · ${selection.country.toUpperCase()}`}
        actions={
          <Button asChild variant="outline">
            <Link to="/reviews">
              원문 리뷰 보기
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        }
      />

      {error ? (
        <Card className="border-destructive/30">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="리뷰 수" value={summary ? summary.total_reviews.toLocaleString() : '0'} hint="최근 30일" icon={MessageSquareText} />
        <MetricCard
          label="주요 이슈 수"
          value={summary ? summary.issue_count.toLocaleString() : '0'}
          hint="중복 문제 라벨 기준"
          icon={TriangleAlert}
          accentClassName="text-warning"
        />
        <MetricCard
          label="1~2점 리뷰"
          value={summary ? summary.low_rating_count.toLocaleString() : '0'}
          hint={summary ? `${summary.low_rating_ratio.toFixed(1)}%` : '0.0%'}
          icon={Clock3}
        />
        <MetricCard
          label="평균 평점"
          value={summary ? summary.average_rating.toFixed(2) : '0.00'}
          hint={`긍정 비율 ${summary?.positive_ratio.toFixed(1) ?? '0.0'}%`}
          icon={Star}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.45fr_0.95fr]">
        <Card>
          <CardHeader>
            <div className="flex items-end justify-between gap-3">
              <div>
                <CardTitle className="text-xl">주요 문제</CardTitle>
                <CardDescription>리뷰 수와 평점 영향이 큰 문제를 먼저 봅니다.</CardDescription>
              </div>
              <Badge variant="outline">{issues.length}개</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-3">문제</th>
                    <th className="px-3 py-3">유형</th>
                    <th className="px-3 py-3">리뷰 수</th>
                    <th className="px-3 py-3">1~2점</th>
                    <th className="px-3 py-3">변화</th>
                    <th className="px-3 py-3">요약</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.length > 0 ? (
                    issues.map((issue) => (
                      <tr
                        key={issue.issue_label}
                        className="cursor-pointer border-b border-border/80 transition-colors hover:bg-accent/60"
                        onClick={() => navigate(`/reviews?issueLabel=${encodeURIComponent(issue.issue_label)}`)}
                      >
                        <td className="px-3 py-3 font-semibold text-foreground">{issue.issue_label}</td>
                        <td className="px-3 py-3">
                          <Badge variant="outline">{issue.category}</Badge>
                        </td>
                        <td className="px-3 py-3 font-semibold text-foreground">{issue.review_count.toLocaleString()}</td>
                        <td className="px-3 py-3 text-foreground">{issue.low_rating_count.toLocaleString()}</td>
                        <td className="px-3 py-3 text-muted-foreground">{formatIssueDelta(issue.change_percent)}</td>
                        <td className="px-3 py-3 text-muted-foreground">{issue.reason_summary || '-'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                        표시할 문제가 없습니다.
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
            <CardDescription>유형별 비중만 원형 차트로 봅니다.</CardDescription>
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

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <div className="flex items-end justify-between gap-3">
              <div>
                <CardTitle className="text-xl">대표 리뷰</CardTitle>
                <CardDescription>문제 라벨과 함께 최근 리뷰를 바로 확인합니다.</CardDescription>
              </div>
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
                  onClick={() => navigate(`/reviews?issueLabel=${encodeURIComponent(item.issue_label)}`)}
                  className="rounded-xl border border-border bg-panel p-4 text-left transition-colors hover:bg-accent/60"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={item.priority === 'Critical' ? 'destructive' : item.priority === 'High' ? 'warning' : 'secondary'}>
                      {item.priority}
                    </Badge>
                    <Badge variant="outline">{item.issue_label}</Badge>
                  </div>
                  <p className="mt-3 text-sm font-semibold text-foreground">{item.summary}</p>
                  <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{item.content}</p>
                </button>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">표시할 리뷰가 없습니다.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">최근 반영</CardTitle>
            <CardDescription>최근 처리된 실행 이력입니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {runs.length > 0 ? (
              runs.map((run) => (
                <div key={run.run_id} className="rounded-xl border border-border bg-panel px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-foreground">{run.status === 'published' ? '반영 완료' : run.status}</p>
                    <Badge variant={run.status === 'published' ? 'success' : run.status === 'failed' ? 'destructive' : 'secondary'}>
                      {run.review_count}건
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{new Date(run.updated_at).toLocaleString()}</p>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">최근 반영 이력이 없습니다.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
