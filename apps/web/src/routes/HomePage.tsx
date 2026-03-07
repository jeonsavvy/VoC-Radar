import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Activity,
  ArrowRight,
  ChartNoAxesCombined,
  CircleAlert,
  MessagesSquare,
  ShieldCheck,
  SmilePlus,
  Star,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { TrendChart } from '@/components/charts/trend-chart';
import { MetricCard } from '@/components/metric-card';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getCategories, getOverview, getPublicAppMeta, getPublicApps, getTrends } from '@/lib/api';
import type { AppSelection } from '@/lib/appSelection';
import type { PublicAppItem, PublicCategoryPoint, PublicOverview, PublicTrendPoint } from '@/types';

type Props = {
  selection: AppSelection;
};

function asFriendlyError(error: unknown) {
  if (!(error instanceof Error)) {
    return '데이터를 불러오지 못했습니다.';
  }
  if (error.message.includes('VITE_API_BASE_URL')) {
    return error.message;
  }
  return '대시보드 데이터를 불러오지 못했습니다. 잠시 후 다시 시도하세요.';
}

function getHealthScore(overview: PublicOverview | null) {
  if (!overview) {
    return 0;
  }

  const total = Math.max(overview.total_reviews, 1);
  const criticalPenalty = Math.min(overview.critical_count / total, 0.35);
  const lowRatingPenalty = Math.min(overview.low_rating_count / total, 0.45);
  const ratingScore = (overview.average_rating / 5) * 46;
  const satisfactionScore = (overview.positive_ratio / 100) * 34;
  const stabilityScore = (1 - criticalPenalty - lowRatingPenalty / 2) * 20;

  return Math.max(0, Math.min(100, Math.round(ratingScore + satisfactionScore + stabilityScore)));
}

function getMomentum(trends: PublicTrendPoint[]) {
  if (trends.length < 4) {
    return null;
  }

  const windowSize = Math.max(2, Math.floor(trends.length / 4));
  const previous = trends.slice(-windowSize * 2, -windowSize);
  const current = trends.slice(-windowSize);
  const previousAvg = previous.reduce((sum, item) => sum + item.total_reviews, 0) / Math.max(previous.length, 1);
  const currentAvg = current.reduce((sum, item) => sum + item.total_reviews, 0) / Math.max(current.length, 1);

  if (previousAvg === 0) {
    return null;
  }

  return ((currentAvg - previousAvg) / previousAvg) * 100;
}

function getNarratives(overview: PublicOverview | null, categories: PublicCategoryPoint[], trends: PublicTrendPoint[]) {
  if (!overview) {
    return [];
  }

  const topCategory = categories[0];
  const momentum = getMomentum(trends);
  const narratives = [
    {
      title: '핵심 이슈 집중도',
      body: topCategory
        ? `${topCategory.category} 카테고리가 전체의 ${topCategory.share_percent.toFixed(1)}%를 차지합니다.`
        : '카테고리 분포 데이터가 아직 없습니다.',
    },
    {
      title: 'Critical 관리 상태',
      body:
        overview.critical_count > 0
          ? `최근 30일 Critical ${overview.critical_count.toLocaleString()}건이 감지되었습니다. 상세 리뷰 워크벤치에서 즉시 원문을 확인하세요.`
          : '최근 30일 Critical 이슈가 감지되지 않았습니다.',
    },
    {
      title: '리뷰 볼륨 모멘텀',
      body:
        momentum == null
          ? '트렌드 변화율을 계산하기 위한 데이터가 더 필요합니다.'
          : `${momentum >= 0 ? '+' : ''}${momentum.toFixed(1)}% 수준으로 최근 리뷰 유입량이 ${momentum >= 0 ? '증가' : '감소'}했습니다.`,
    },
  ];

  return narratives;
}

export function HomePage({ selection }: Props) {
  const [overview, setOverview] = useState<PublicOverview | null>(null);
  const [categories, setCategories] = useState<PublicCategoryPoint[]>([]);
  const [trends, setTrends] = useState<PublicTrendPoint[]>([]);
  const [appName, setAppName] = useState<string | null>(null);
  const [recentApps, setRecentApps] = useState<PublicAppItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError(null);

    Promise.all([
      getOverview(selection.appId, selection.country),
      getCategories(selection.appId, selection.country),
      getTrends(selection.appId, selection.country),
      getPublicAppMeta(selection.appId, selection.country),
      getPublicApps(5),
    ])
      .then(([overviewResult, categoriesResult, trendsResult, metaResult, appsResult]) => {
        if (!active) {
          return;
        }
        setOverview(overviewResult.data);
        setCategories(categoriesResult.data);
        setTrends(trendsResult.data);
        setAppName(metaResult.data.app_name?.trim() || null);
        setRecentApps(appsResult.data);
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        setError(asFriendlyError(err));
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

  const healthScore = getHealthScore(overview);
  const criticalRate = overview ? (overview.critical_count / Math.max(overview.total_reviews, 1)) * 100 : 0;
  const narratives = useMemo(() => getNarratives(overview, categories, trends), [overview, categories, trends]);
  const topCategories = categories.slice(0, 5);
  const selectedAppLabel = appName || 'Unknown App';

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Signal Desk"
          title="리뷰 신호를 운영 우선순위로 바꾸는 중입니다."
          description="현재 선택한 앱의 공개 리포트를 준비하고 있습니다."
          status="Loading"
        />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index}>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-10 w-32" />
                <Skeleton className="h-4 w-40" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-[1.4fr_0.9fr]">
          <Card>
            <CardContent className="p-6">
              <Skeleton className="h-64 w-full rounded-2xl" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-4 p-6">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-20 w-full rounded-2xl" />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Signal Desk"
        title={`${selectedAppLabel}의 리뷰 흐름을 한 눈에 읽습니다.`}
        description="공개 지표와 카테고리 흐름을 같은 화면에 배치해, 어떤 VoC가 운영 우선순위를 끌어올리는지 빠르게 판단할 수 있게 구성했습니다."
        status={`Health score · ${healthScore}`}
        meta={`${selection.appId} · ${selection.country.toUpperCase()}`}
        actions={
          <>
            <Button asChild>
              <Link to="/analyze">
                파이프라인 실행
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/reviews">상세 리뷰 열기</Link>
            </Button>
          </>
        }
      />

      {error ? (
        <Card className="border-destructive/30">
          <CardContent className="flex items-center gap-3 p-5 text-destructive">
            <CircleAlert className="size-5" />
            <p role="alert" className="text-sm font-medium">
              {error}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="30일 리뷰 수"
          value={overview ? overview.total_reviews.toLocaleString() : '0'}
          hint="선택 앱 기준 공개 집계"
          icon={MessagesSquare}
        />
        <MetricCard
          label="Critical incidents"
          value={overview ? overview.critical_count.toLocaleString() : '0'}
          hint={`${criticalRate.toFixed(1)}% of total reviews`}
          icon={CircleAlert}
          accentClassName="text-warning"
        />
        <MetricCard
          label="평균 평점"
          value={overview ? overview.average_rating.toFixed(2) : '0.00'}
          hint={`Positive ratio ${overview?.positive_ratio.toFixed(1) ?? '0.0'}%`}
          icon={Star}
        />
        <MetricCard
          label="운영 신뢰 점수"
          value={`${healthScore}`}
          hint={healthScore >= 75 ? '안정적' : healthScore >= 50 ? '주의 관찰' : '즉시 대응 필요'}
          icon={ShieldCheck}
          accentClassName={healthScore >= 75 ? 'text-success' : healthScore >= 50 ? 'text-warning' : 'text-destructive'}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.45fr_0.95fr]">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <ChartNoAxesCombined className="size-5 text-primary" />
                  볼륨 & Critical 트렌드
                </CardTitle>
                <CardDescription>
                  최근 30일 기준 일별 리뷰 유입과 Critical 발생 흐름을 동시에 보여줍니다.
                </CardDescription>
              </div>
              <Badge variant="secondary">{trends.length} data points</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {trends.length > 0 ? (
              <TrendChart data={trends} />
            ) : (
              <div className="rounded-2xl border border-border/70 bg-background/40 p-6 text-sm text-muted-foreground">
                트렌드 데이터가 아직 없습니다.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Activity className="size-5 text-primary" />
              지금 읽어야 할 신호
            </CardTitle>
            <CardDescription>숫자만으로 놓치기 쉬운 운영 포인트를 문장으로 정리했습니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {narratives.map((narrative) => (
              <div key={narrative.title} className="rounded-2xl border border-border/70 bg-background/40 p-4">
                <p className="text-sm font-semibold text-foreground">{narrative.title}</p>
                <p className="mt-2 text-sm text-muted-foreground">{narrative.body}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">카테고리 점유율</CardTitle>
            <CardDescription>가장 비중이 큰 VoC부터 우선순위 관점으로 정렬됩니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {topCategories.length > 0 ? (
              topCategories.map((category, index) => (
                <div key={category.category} className="rounded-2xl border border-border/70 bg-background/35 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{category.category}</p>
                      <p className="text-xs text-muted-foreground">{category.total_reviews.toLocaleString()} reviews</p>
                    </div>
                    <Badge variant={index === 0 ? 'default' : 'secondary'}>{category.share_percent.toFixed(1)}%</Badge>
                  </div>
                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-secondary/70">
                    <motion.div
                      className="h-full rounded-full bg-primary"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.max(6, category.share_percent)}%` }}
                      transition={{ duration: 0.45 + index * 0.05, ease: 'easeOut' }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">카테고리 데이터가 없습니다.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">최근 모니터링 앱</CardTitle>
            <CardDescription>최근 적재된 앱 기준으로 빠르게 컨텍스트를 전환할 수 있습니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentApps.length > 0 ? (
              recentApps.map((app) => (
                <div key={`${app.app_store_id}-${app.country}`} className="rounded-2xl border border-border/70 bg-background/35 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{app.app_name || '이름 미확인 앱'}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {app.app_store_id} · {app.country.toUpperCase()}
                      </p>
                    </div>
                    <Badge variant={app.app_store_id === selection.appId ? 'default' : 'outline'}>
                      {app.app_store_id === selection.appId ? 'Selected' : 'Recent'}
                    </Badge>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-border/70 bg-background/35 p-4 text-sm text-muted-foreground">
                적재된 앱 메타가 아직 없습니다.
              </div>
            )}

            <div className="rounded-2xl border border-primary/20 bg-primary/8 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <SmilePlus className="size-4 text-primary" />
                운영 팁
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                상세 워크벤치에서는 로그인 후 검색·정렬·컬럼 제어까지 가능하므로, 공개 지표에서 징후가 보이면 바로 Reviews로 넘어가는 흐름을 권장합니다.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
