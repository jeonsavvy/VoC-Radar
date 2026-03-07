import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Search } from 'lucide-react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getCategories, getPrivateReviews } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import type { AppSelection } from '@/lib/appSelection';
import type { PrivateReviewItem, PrivateReviewSortKey } from '@/types';

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
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<PrivateReviewItem[]>([]);
  const [selectedReview, setSelectedReview] = useState<PrivateReviewItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchKeyword, setSearchKeyword] = useState(searchParams.get('search') || '');
  const [debouncedSearch, setDebouncedSearch] = useState(searchParams.get('search') || '');
  const [ratingFilter, setRatingFilter] = useState<'all' | '1' | '2' | '3' | '4' | '5'>(searchParams.get('rating') as any || 'all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | PrivateReviewItem['priority']>(searchParams.get('priority') as any || 'all');
  const [categoryFilter, setCategoryFilter] = useState<string>(searchParams.get('category') || 'all');
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<PrivateReviewSortKey>('reviewed_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState<10 | 25 | 50>(25);
  const [hasNext, setHasNext] = useState(false);
  const latestRequestRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchKeyword.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchKeyword]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (debouncedSearch) next.set('search', debouncedSearch);
    if (ratingFilter !== 'all') next.set('rating', ratingFilter);
    if (priorityFilter !== 'all') next.set('priority', priorityFilter);
    if (categoryFilter !== 'all') next.set('category', categoryFilter);
    setSearchParams(next, { replace: true });
  }, [debouncedSearch, ratingFilter, priorityFilter, categoryFilter, setSearchParams]);

  useEffect(() => {
    const categoryFromQuery = searchParams.get('category');
    if (categoryFromQuery && categoryFromQuery !== categoryFilter) {
      setCategoryFilter(categoryFromQuery);
    }
  }, [searchParams, categoryFilter]);

  useEffect(() => {
    setPage(1);
  }, [selection.appId, selection.country, limit, sortKey, sortDirection, ratingFilter, priorityFilter, categoryFilter, debouncedSearch]);

  useEffect(() => {
    let mounted = true;

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

    if (!loggedIn) {
      setItems([]);
      setLoading(false);
      setHasNext(false);
      return () => {
        mounted = false;
      };
    }

    const load = async () => {
      setLoading(true);
      setError(null);
      const requestId = latestRequestRef.current + 1;
      latestRequestRef.current = requestId;
      try {
        const token = await getAccessToken();
        if (!token) {
          throw new Error('인증 토큰을 찾을 수 없습니다. 다시 로그인하세요.');
        }
        const response = await getPrivateReviews(selection.appId, token, {
          country: selection.country,
          page,
          limit,
          sortBy: sortKey,
          sortDirection,
          rating: ratingFilter === 'all' ? undefined : (Number(ratingFilter) as 1 | 2 | 3 | 4 | 5),
          priority: priorityFilter === 'all' ? undefined : priorityFilter,
          category: categoryFilter === 'all' ? undefined : categoryFilter,
          search: debouncedSearch || undefined,
        });

        if (!mounted || requestId !== latestRequestRef.current) {
          return;
        }
        setItems(response.data);
        setHasNext(response.hasNext);
      } catch (err) {
        if (!mounted || requestId !== latestRequestRef.current) {
          return;
        }
        setError(err instanceof Error ? err.message : '원문 리뷰를 불러오지 못했습니다.');
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

  if (!loggedIn) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="원문 리뷰" />

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
              <CardDescription>유형, 우선순위, 별점 기준으로 원문 리뷰를 좁혀봅니다.</CardDescription>
            </div>
            <Badge variant={activeFilterCount > 0 ? 'default' : 'secondary'}>{activeFilterCount}개 필터 적용</Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2 xl:grid-cols-5">
          <div className="xl:col-span-2">
            <Label htmlFor="review-search">검색어</Label>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="review-search" value={searchKeyword} onChange={(event) => setSearchKeyword(event.target.value)} className="pl-9" placeholder="요약, 원문 검색" />
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

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">원문 리뷰 목록</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="min-w-[1080px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-3">유형</th>
                  <th className="px-3 py-3">별점</th>
                  <th className="px-3 py-3">좌요약</th>
                  <th className="px-3 py-3">우원문</th>
                  <th className="px-3 py-3 text-right">상세</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 6 }).map((_, index) => (
                    <tr key={index} className="border-b border-border/80">
                      {Array.from({ length: 5 }).map((__, cellIndex) => (
                        <td key={cellIndex} className="px-3 py-4">
                          <div className="h-4 rounded-full bg-muted/70" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : items.length > 0 ? (
                  items.map((item) => (
                    <tr key={item.review_id} className="border-b border-border/80 transition-colors hover:bg-accent/50">
                      <td className="px-3 py-3">
                        <Badge variant="outline">{item.category}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-foreground">{item.rating}</span>
                          <Badge variant={PRIORITY_VARIANT[item.priority]}>{item.priority}</Badge>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <p className="font-medium text-foreground">{item.summary}</p>
                      </td>
                      <td className="px-3 py-3">
                        <p className="line-clamp-3 text-sm text-muted-foreground">{item.content}</p>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <Button variant="outline" size="sm" onClick={() => setSelectedReview(item)}>
                          <Eye className="size-4" />
                          보기
                        </Button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="px-3 py-12 text-center text-muted-foreground">
                      조건에 맞는 리뷰가 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {selectedReview ? (
        <Dialog open={Boolean(selectedReview)} onOpenChange={(open) => !open && setSelectedReview(null)}>
          <DialogContent>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{selectedReview.category}</Badge>
                <Badge variant={PRIORITY_VARIANT[selectedReview.priority]}>{selectedReview.priority}</Badge>
                <Badge variant="outline">{selectedReview.rating}점</Badge>
              </div>
              <DialogTitle>{selectedReview.summary}</DialogTitle>
              <DialogDescription>
                {new Date(selectedReview.reviewed_at).toLocaleString()} · {selectedReview.author || '작성자 미상'}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4">
              <div className="rounded-xl border border-border bg-panel px-4 py-4">
                <p className="text-xs font-medium text-muted-foreground">요약</p>
                <p className="mt-2 text-sm text-foreground">{selectedReview.summary}</p>
              </div>
              <div className="rounded-xl border border-border bg-panel px-4 py-4">
                <p className="text-xs font-medium text-muted-foreground">원문 리뷰</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{selectedReview.content}</p>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
