import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Clock3, MessagesSquare, RefreshCcw, Star } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { TrendChart } from '@/components/charts/trend-chart';
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

const RANGE_OPTIONS = [
  { label: '7일', days: 7 },
  { label: '30일', days: 30 },
  { label: '90일', days: 90 },
] as const;

function toDateRange(days: number) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

function formatChange(value: number | null) {
  if (value == null) {
    return '신규';
  }

  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function HomePage({ selection }: Props) {
  const navigate = useNavigate();
  const [rangeDays, setRangeDays] = useState<(typeof RANGE_OPTIONS)[number]['days']>(30);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const { from, to } = toDateRange(rangeDays);

    setLoading(true);
    setError(null);

    getDashboard(selection.appId, selection.country, from, to)
      .then((response) => {
        if (!active) {
          return;
        }
        setDashboard(response.data);
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        setDashboard(null);
        setError(err instanceof Error ? err.message : '대시보드 데이터를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [rangeDays, selection.appId, selection.country]);

  const summary = dashboard?.summary;
  const issues = dashboard?.issues ?? [];
  const evidence = dashboard?.evidence ?? [];
  const runs = dashboard?.runs ?? [];
  const categories = dashboard?.categories ?? [];
  const trends = dashboard?.trends ?? [];

  const primaryIssue = useMemo(() => issues[0] || null, [issues]);

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="대시보드"
          title="문제와 액션을 불러오는 중입니다."
          description="선택한 앱 기준으로 최근 리뷰와 실행 이력을 정리하고 있습니다."
          status="로딩 중"
        />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index}>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-4 w-40" />
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
        title={`${summary?.app_name || '선택 앱'}의 문제와 액션을 한 화면에서 확인합니다.`}
        description="최근 리뷰 흐름에서 지금 먼저 볼 문제, 원인, 후속 액션을 실무형 표와 근거 리뷰 중심으로 정리했습니다."
        status={summary?.last_published_at ? `마지막 반영 ${new Date(summary.last_published_at).toLocaleString()}` : '반영 이력 없음'}
        meta={`${selection.appId} · ${selection.country.toUpperCase()}`}
        actions={
          <>
            <div className="flex flex-wrap gap-2">
              {RANGE_OPTIONS.map((item) => (
                <Button
                  key={item.days}
                  type="button"
                  variant={rangeDays === item.days ? 'default' : 'outline'}
                  onClick={() => setRangeDays(item.days)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <Button asChild variant="outline">
              <Link to="/analyze">
                리뷰 다시 수집
                <RefreshCcw className="size-4" />
              </Link>
            </Button>
          </>
        }
      />

      {error ? (
        <Card className="border-destructive/30">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="최근 리뷰 수"
          value={summary ? summary.total_reviews.toLocaleString() : '0'}
          hint={`${rangeDays}일 기준`}
          icon={MessagesSquare}
        />
        <MetricCard
          label="즉시 확인 필요"
          value={summary ? summary.issue_count.toLocaleString() : '0'}
          hint={primaryIssue ? `우선 문제: ${primaryIssue.issue_label}` : '활성 이슈 없음'}
          icon={AlertTriangle}
          accentClassName="text-warning"
        />
        <MetricCard
          label="1~2점 리뷰 비중"
          value={summary ? `${summary.low_rating_ratio.toFixed(1)}%` : '0.0%'}
          hint={summary ? `${summary.low_rating_count.toLocaleString()}건` : '0건'}
          icon={Clock3}
        />
        <MetricCard
          label="평균 평점"
          value={summary ? summary.average_rating.toFixed(2) : '0.00'}
          hint={`긍정 비율 ${summary?.positive_ratio.toFixed(1) ?? '0.0'}%`}
          icon={Star}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.5fr_0.9fr]">
        <Card>
          <CardHeader>
            <div className="flex items-end justify-between gap-3">
              <div>
                <CardTitle className="text-xl">지금 먼저 볼 문제</CardTitle>
                <CardDescription>영향 리뷰 수와 최근 증가율이 큰 순서로 정리했습니다.</CardDescription>
              </div>
              <Badge variant="outline">{issues.length}개 이슈</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-3">문제</th>
                    <th className="px-3 py-3">유형</th>
                    <th className="px-3 py-3">영향 리뷰</th>
                    <th className="px-3 py-3">증감</th>
                    <th className="px-3 py-3">대표 원인</th>
                    <th className="px-3 py-3">권장 액션</th>
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
                        <td className="px-3 py-3">
                          <p className="font-semibold text-foreground">{issue.issue_label}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            최신 리뷰 {new Date(issue.last_review_at).toLocaleDateString()}
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          <Badge variant="outline">{issue.category}</Badge>
                        </td>
                        <td className="px-3 py-3 font-semibold text-foreground">{issue.review_count.toLocaleString()}</td>
                        <td className="px-3 py-3">
                          <Badge variant={issue.change_percent != null && issue.change_percent > 0 ? 'warning' : 'secondary'}>
                            {formatChange(issue.change_percent)}
                          </Badge>
                        </td>
                        <td className="px-3 py-3 text-muted-foreground">{issue.reason_summary || '-'}</td>
                        <td className="px-3 py-3 text-foreground">{issue.action_hint || '-'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                        현재 표시할 이슈가 없습니다.
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
            <CardTitle className="text-xl">최근 실행 현황</CardTitle>
            <CardDescription>수집/반영 상태를 확인하고 바로 수집 실행으로 이어집니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {runs.length > 0 ? (
              runs.map((run) => (
                <div key={run.run_id} className="rounded-xl border border-border bg-panel px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{run.status === 'published' ? '반영 완료' : run.status}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{new Date(run.updated_at).toLocaleString()}</p>
                    </div>
                    <Badge variant={run.status === 'published' ? 'success' : run.status === 'failed' ? 'destructive' : 'secondary'}>
                      {run.review_count}건
                    </Badge>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">실행 이력이 없습니다.</p>
            )}
            <Button asChild className="w-full">
              <Link to="/analyze">
                수집 실행으로 이동
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">리뷰 추이</CardTitle>
            <CardDescription>리뷰 유입과 즉시 확인 필요 흐름을 함께 봅니다.</CardDescription>
          </CardHeader>
          <CardContent>
            {trends.length > 0 ? <TrendChart data={trends} /> : <p className="text-sm text-muted-foreground">추이 데이터가 없습니다.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">유형별 분포</CardTitle>
            <CardDescription>현재 어떤 문제군이 가장 크게 쌓이는지 확인합니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {categories.length > 0 ? (
              categories.map((item) => (
                <div key={item.category} className="rounded-xl border border-border bg-panel px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{item.category}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{item.total_reviews.toLocaleString()}건</p>
                    </div>
                    <span className="text-sm font-semibold text-primary">{item.share_percent.toFixed(1)}%</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(6, item.share_percent)}%` }} />
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">분포 데이터가 없습니다.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-end justify-between gap-3">
            <div>
              <CardTitle className="text-xl">근거 리뷰</CardTitle>
              <CardDescription>대표 리뷰를 바로 열어 원문과 액션을 확인할 수 있습니다.</CardDescription>
            </div>
            <Button asChild variant="outline">
              <Link to="/reviews">원문 리뷰 전체 보기</Link>
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
                <div className="mt-3 border-t border-border pt-3">
                  <p className="text-xs font-medium text-muted-foreground">권장 액션</p>
                  <p className="mt-1 text-sm text-foreground">{item.action_hint}</p>
                </div>
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
