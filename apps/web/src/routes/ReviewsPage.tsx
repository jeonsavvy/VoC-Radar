import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getCategories, getDashboard, getPrivateReviews, getPublicReviews } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import type { AppSelection } from '@/lib/appSelection';
import type { PrivateReviewItem, PrivateReviewSortKey } from '@/types';

// ReviewsPage는 선택한 앱의 리뷰 원문과 AI 분류 결과를 함께 조회하는 화면이다.
// 로그인 여부에 따라 private/public API를 나눠 호출한다.
type Props = {
  loggedIn: boolean;
  selection: AppSelection;
};

const PRIORITY_VARIANT = {
  Normal: 'secondary',
  High: 'warning',
  Critical: 'destructive',
} as const;

export function ReviewsPage({ loggedIn, selection }: Props) {
  const [items, setItems] = useState<PrivateReviewItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [ratingFilter, setRatingFilter] = useState<'all' | '1' | '2' | '3' | '4' | '5'>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | PrivateReviewItem['priority']>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<PrivateReviewSortKey>('reviewed_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState<10 | 25 | 50>(25);
  const [hasNext, setHasNext] = useState(false);
  const latestRequestRef = useRef(0);

  // 검색 입력은 짧은 지연을 둬서 과도한 요청을 막는다.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchKeyword.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchKeyword]);

  useEffect(() => {
    setPage(1);
  }, [selection.appId, selection.country, limit, sortKey, sortDirection, ratingFilter, priorityFilter, categoryFilter, debouncedSearch]);

  useEffect(() => {
    let mounted = true;

    // 카테고리 필터 옵션은 대시보드 집계 기준으로 먼저 채운다.
    getCategories(selection.appId, selection.country)
      .then((response) => {
        if (mounted) {
          setCategoryOptions(response.data.map((item) => item.category));
        }
      })
      .catch(() => {
        if (mounted) {
          setCategoryOptions([]);
        }
      });

    return () => {
      mounted = false;
    };
  }, [selection.appId, selection.country]);

  useEffect(() => {
    let mounted = true;

    // 가장 최근 요청만 화면 상태를 갱신하도록 request id를 비교한다.
    const load = async () => {
      setLoading(true);
      setError(null);
      const requestId = latestRequestRef.current + 1;
      latestRequestRef.current = requestId;
      try {
        const options = {
          country: selection.country,
          page,
          limit,
          sortBy: sortKey,
          sortDirection,
          rating: ratingFilter === 'all' ? undefined : (Number(ratingFilter) as 1 | 2 | 3 | 4 | 5),
          priority: priorityFilter === 'all' ? undefined : priorityFilter,
          category: categoryFilter === 'all' ? undefined : categoryFilter,
          search: debouncedSearch || undefined,
        };

        const response = loggedIn
          ? await (async () => {
              const token = await getAccessToken();
              if (!token) {
                throw new Error('인증 토큰을 찾을 수 없습니다. 다시 로그인하세요.');
              }
              return getPrivateReviews(selection.appId, token, options);
            })()
          : await (async () => {
              try {
                return await getPublicReviews(selection.appId, options);
              } catch (error) {
                // 공개 상세 리뷰 엔드포인트가 비활성화된 환경에선 대시보드 evidence로 대체한다.
                if (error instanceof Error && error.message.includes('404')) {
                  const to = new Date();
                  const from = new Date();
                  from.setDate(from.getDate() - 30);
                  const dashboard = await getDashboard(selection.appId, selection.country, from.toISOString(), to.toISOString());
                  const fallbackData: PrivateReviewItem[] = dashboard.data.evidence.map((item) => ({
                    review_id: item.review_id,
                    app_store_id: selection.appId,
                    country: selection.country,
                    rating: item.rating,
                    author: item.author,
                    content: item.content,
                    reviewed_at: item.reviewed_at,
                    priority: item.priority,
                    category: item.category,
                    issue_label: item.issue_label,
                    reason_summary: item.summary,
                    action_hint: '',
                    summary: item.summary,
                    confidence: null,
                  }));

                  return {
                    data: fallbackData,
                    page: 1,
                    limit,
                    hasNext: false,
                    nextCursor: null,
                  };
                }

                throw error;
              }
            })();

        if (!mounted || requestId !== latestRequestRef.current) {
          return;
        }

        setItems(response.data);
        setHasNext(response.hasNext);
      } catch (err) {
        if (!mounted || requestId !== latestRequestRef.current) {
          return;
        }
        setError(err instanceof Error ? err.message : '리뷰를 불러오지 못했습니다.');
        setItems([]);
        setHasNext(false);
      } finally {
        if (mounted && requestId === latestRequestRef.current) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      mounted = false;
    };
  }, [
    loggedIn,
    selection.appId,
    selection.country,
    page,
    limit,
    sortKey,
    sortDirection,
    ratingFilter,
    priorityFilter,
    categoryFilter,
    debouncedSearch,
  ]);

  const activeFilterCount = useMemo(
    () => [debouncedSearch, ratingFilter !== 'all', priorityFilter !== 'all', categoryFilter !== 'all'].filter(Boolean).length,
    [debouncedSearch, ratingFilter, priorityFilter, categoryFilter],
  );

  return (
    <div className="space-y-6">
      <PageHeader title="리뷰" />

      {error ? (
        <Card className="border-destructive/20">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-end justify-between gap-3">
            <div>
              <CardTitle className="text-xl">조회 조건</CardTitle>
              <CardDescription>유형, 우선순위, 별점 기준으로 리뷰를 좁혀봅니다.</CardDescription>
            </div>
            <Badge variant={activeFilterCount > 0 ? 'default' : 'secondary'}>{activeFilterCount}개 필터 적용</Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2 xl:grid-cols-5">
          <div className="xl:col-span-2">
            <Label htmlFor="review-search">검색어</Label>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="review-search" value={searchKeyword} onChange={(event) => setSearchKeyword(event.target.value)} className="pl-9" placeholder="요약, 리뷰 검색" />
            </div>
          </div>

          <div>
            <Label>유형</Label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="전체" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                {categoryOptions.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>우선순위</Label>
            <Select value={priorityFilter} onValueChange={(value) => setPriorityFilter(value as typeof priorityFilter)}>
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="전체" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                <SelectItem value="Critical">Critical</SelectItem>
                <SelectItem value="High">High</SelectItem>
                <SelectItem value="Normal">Normal</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>별점</Label>
            <Select value={ratingFilter} onValueChange={(value) => setRatingFilter(value as typeof ratingFilter)}>
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="전체" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                <SelectItem value="1">1점</SelectItem>
                <SelectItem value="2">2점</SelectItem>
                <SelectItem value="3">3점</SelectItem>
                <SelectItem value="4">4점</SelectItem>
                <SelectItem value="5">5점</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 xl:col-span-5 xl:grid-cols-[180px_180px_120px_auto]">
            <div>
              <Label>정렬 기준</Label>
              <Select value={sortKey} onValueChange={(value) => setSortKey(value as PrivateReviewSortKey)}>
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reviewed_at">작성일</SelectItem>
                  <SelectItem value="rating">별점</SelectItem>
                  <SelectItem value="priority">우선순위</SelectItem>
                  <SelectItem value="category">유형</SelectItem>
                  <SelectItem value="summary">요약</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>정렬 방향</Label>
              <Select value={sortDirection} onValueChange={(value) => setSortDirection(value as 'asc' | 'desc')}>
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="desc">내림차순</SelectItem>
                  <SelectItem value="asc">오름차순</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>표시 수</Label>
              <Select value={String(limit)} onValueChange={(value) => setLimit(Number(value) as 10 | 25 | 50)}>
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-end justify-end gap-2">
              <Button variant="outline" onClick={() => setPage((previous) => Math.max(1, previous - 1))} disabled={loading || page <= 1}>
                이전
              </Button>
              <Button variant="outline" onClick={() => setPage((previous) => previous + 1)} disabled={loading || !hasNext}>
                다음
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setSearchKeyword('');
                  setDebouncedSearch('');
                  setRatingFilter('all');
                  setPriorityFilter('all');
                  setCategoryFilter('all');
                  setSortKey('reviewed_at');
                  setSortDirection('desc');
                  setLimit(25);
                }}
              >
                초기화
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {loading
          ? Array.from({ length: 4 }).map((_, index) => (
              <Card key={index}>
                <CardContent className="space-y-4 p-6">
                  <div className="h-4 w-28 animate-pulse rounded-full bg-muted/70" />
                  <div className="h-8 w-48 animate-pulse rounded-full bg-muted/70" />
                  <div className="h-24 rounded-xl bg-muted/70" />
                  <div className="h-24 rounded-xl bg-muted/70" />
                </CardContent>
              </Card>
            ))
          : items.length > 0
            ? items.map((item) => (
                <Card key={item.review_id}>
                  <CardContent className="space-y-4 p-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{item.category}</Badge>
                      <Badge variant={PRIORITY_VARIANT[item.priority]}>{item.priority}</Badge>
                      <Badge variant="outline">{item.rating}점</Badge>
                    </div>

                    <div className="space-y-1">
                      <h3 className="text-2xl font-semibold tracking-[-0.03em] text-foreground">{item.summary}</h3>
                      <p className="text-sm text-muted-foreground">
                        {new Date(item.reviewed_at).toLocaleString()} · {item.author || '작성자 미상'}
                      </p>
                    </div>

                    <div className="rounded-xl border border-border bg-panel px-4 py-4">
                      <p className="text-xs font-medium text-muted-foreground">리뷰</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{item.content}</p>
                    </div>
                  </CardContent>
                </Card>
              ))
            : (
              <Card>
                <CardContent className="p-10 text-center text-sm text-muted-foreground">조건에 맞는 리뷰가 없습니다.</CardContent>
              </Card>
            )}
      </div>
    </div>
  );
}
