import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Columns3,
  Eye,
  Filter,
  ListFilter,
  MessageSquareText,
  Search,
  Star,
  Wrench,
} from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getCategories, getPrivateReviews } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { cn } from '@/lib/utils';
import type { AppSelection } from '@/lib/appSelection';
import type { Priority, PrivateReviewItem, PrivateReviewSortKey } from '@/types';

type Props = {
  loggedIn: boolean;
  selection: AppSelection;
};

const PRIORITY_ORDER: Record<Priority, number> = {
  Normal: 0,
  High: 1,
  Critical: 2,
};

const PRIORITY_VARIANT: Record<Priority, 'success' | 'warning' | 'destructive'> = {
  Normal: 'success',
  High: 'warning',
  Critical: 'destructive',
};

const REVIEW_COLUMNS = [
  {
    key: 'reviewed_at',
    label: '작성일',
    render: (item: PrivateReviewItem) => (
      <div className="space-y-1">
        <p className="font-medium text-foreground">{new Date(item.reviewed_at).toLocaleDateString()}</p>
        <p className="text-xs text-muted-foreground">{new Date(item.reviewed_at).toLocaleTimeString()}</p>
      </div>
    ),
  },
  {
    key: 'author',
    label: '작성자',
    render: (item: PrivateReviewItem) => (
      <div className="space-y-1">
        <p className="font-medium text-foreground">{item.author || 'Unknown'}</p>
        <p className="text-xs text-muted-foreground">{item.country.toUpperCase()}</p>
      </div>
    ),
  },
  {
    key: 'rating',
    label: '별점',
    render: (item: PrivateReviewItem) => (
      <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/55 px-3 py-1.5">
        <Star className="size-3.5 fill-warning text-warning" />
        <span className="font-medium text-foreground">{item.rating}</span>
      </div>
    ),
  },
  {
    key: 'priority',
    label: '우선순위',
    render: (item: PrivateReviewItem) => <Badge variant={PRIORITY_VARIANT[item.priority]}>{item.priority}</Badge>,
  },
  {
    key: 'category',
    label: '유형',
    render: (item: PrivateReviewItem) => <Badge variant="outline">{item.category}</Badge>,
  },
  {
    key: 'summary',
    label: '요약',
    render: (item: PrivateReviewItem) => (
      <div className="space-y-1">
        <p className="line-clamp-2 max-w-[32rem] text-sm font-medium text-foreground">{item.summary}</p>
        <p className="line-clamp-1 max-w-[32rem] text-xs text-muted-foreground">{item.content}</p>
      </div>
    ),
  },
] as const;

type ReviewColumnKey = (typeof REVIEW_COLUMNS)[number]['key'];

const COLUMN_BY_KEY: Record<ReviewColumnKey, (typeof REVIEW_COLUMNS)[number]> = REVIEW_COLUMNS.reduce(
  (accumulator, column) => {
    accumulator[column.key] = column;
    return accumulator;
  },
  {} as Record<ReviewColumnKey, (typeof REVIEW_COLUMNS)[number]>,
);

const DEFAULT_COLUMN_ORDER: ReviewColumnKey[] = REVIEW_COLUMNS.map((column) => column.key);
const DEFAULT_COLUMN_VISIBILITY: Record<ReviewColumnKey, boolean> = {
  reviewed_at: true,
  author: true,
  rating: true,
  priority: true,
  category: true,
  summary: true,
};

function compareReviewedAt(left: PrivateReviewItem, right: PrivateReviewItem) {
  return new Date(left.reviewed_at).getTime() - new Date(right.reviewed_at).getTime();
}

function comparePrivateReviews(left: PrivateReviewItem, right: PrivateReviewItem, sortKey: PrivateReviewSortKey) {
  if (sortKey === 'reviewed_at') {
    return compareReviewedAt(left, right);
  }
  if (sortKey === 'rating') {
    return left.rating - right.rating;
  }
  if (sortKey === 'priority') {
    return PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
  }

  const leftText = String(left[sortKey] ?? '');
  const rightText = String(right[sortKey] ?? '');
  return leftText.localeCompare(rightText, 'ko');
}

function sortPrivateReviewItems(
  items: PrivateReviewItem[],
  sortKey: PrivateReviewSortKey,
  sortDirection: 'asc' | 'desc',
) {
  const primaryDirection = sortDirection === 'asc' ? 1 : -1;

  return [...items].sort((left, right) => {
    const primary = comparePrivateReviews(left, right, sortKey);
    if (primary !== 0) {
      return primary * primaryDirection;
    }

    const reviewedAt = compareReviewedAt(left, right);
    if (reviewedAt !== 0) {
      return reviewedAt * -1;
    }

    return left.review_id.localeCompare(right.review_id);
  });
}

function activeFilterCount(input: {
  search: string;
  rating: string;
  priority: string;
  category: string;
}) {
  return [input.search.trim(), input.rating !== 'all', input.priority !== 'all', input.category !== 'all'].filter(Boolean)
    .length;
}

export function ReviewsPage({ loggedIn, selection }: Props) {
  const [items, setItems] = useState<PrivateReviewItem[]>([]);
  const [selectedReview, setSelectedReview] = useState<PrivateReviewItem | null>(null);
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
  const [columnOrder, setColumnOrder] = useState<ReviewColumnKey[]>(DEFAULT_COLUMN_ORDER);
  const [columnVisibility, setColumnVisibility] = useState<Record<ReviewColumnKey, boolean>>(DEFAULT_COLUMN_VISIBILITY);
  const latestRequestRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchKeyword.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [searchKeyword]);

  useEffect(() => {
    setPage(1);
  }, [selection.appId, selection.country, limit, sortKey, sortDirection, ratingFilter, priorityFilter, categoryFilter, debouncedSearch]);

  useEffect(() => {
    let mounted = true;

    getCategories(selection.appId, selection.country)
      .then((response) => {
        if (!mounted) {
          return;
        }
        const options = response.data.map((item) => item.category).sort((a, b) => a.localeCompare(b, 'ko'));
        setCategoryOptions(options);
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
      setError(null);
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

        const verifiedItems = response.data.filter((item) => {
          if (ratingFilter !== 'all' && item.rating !== Number(ratingFilter)) return false;
          if (priorityFilter !== 'all' && item.priority !== priorityFilter) return false;
          if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
          if (!debouncedSearch) return true;
          const normalizedKeyword = debouncedSearch.toLowerCase();
          const searchable = [item.author, item.summary, item.category, item.content].join(' ').toLowerCase();
          return searchable.includes(normalizedKeyword);
        });

        setItems(sortPrivateReviewItems(verifiedItems, sortKey, sortDirection));
        setHasNext(response.hasNext);
      } catch (err) {
        if (!mounted || requestId !== latestRequestRef.current) {
          return;
        }
        setError(err instanceof Error ? err.message : '리뷰 상세 조회 실패');
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

  const visibleColumns = useMemo(
    () => columnOrder.map((key) => COLUMN_BY_KEY[key]).filter((column) => columnVisibility[column.key]),
    [columnOrder, columnVisibility],
  );

  const activeColumnCount = Object.values(columnVisibility).filter(Boolean).length;
  const totalFilterCount = activeFilterCount({ search: debouncedSearch, rating: ratingFilter, priority: priorityFilter, category: categoryFilter });

  const toggleColumn = (key: ReviewColumnKey) => {
    setColumnVisibility((previous) => {
      const visibleCount = Object.values(previous).filter(Boolean).length;
      if (previous[key] && visibleCount === 1) {
        return previous;
      }

      return {
        ...previous,
        [key]: !previous[key],
      };
    });
  };

  const moveColumn = (key: ReviewColumnKey, direction: 'up' | 'down') => {
    setColumnOrder((previous) => {
      const currentIndex = previous.indexOf(key);
      if (currentIndex === -1) {
        return previous;
      }

      const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= previous.length) {
        return previous;
      }

      const next = [...previous];
      const currentValue = next[currentIndex];
      const targetValue = next[targetIndex];
      if (!currentValue || !targetValue) {
        return previous;
      }

      next[currentIndex] = targetValue;
      next[targetIndex] = currentValue;
      return next;
    });
  };

  const resetFilters = () => {
    setSearchKeyword('');
    setDebouncedSearch('');
    setRatingFilter('all');
    setPriorityFilter('all');
    setCategoryFilter('all');
    setSortKey('reviewed_at');
    setSortDirection('desc');
    setPage(1);
    setLimit(25);
  };

  if (!loggedIn) {
    return <Navigate to="/login" replace />;
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <PageHeader
          eyebrow="Review Workbench"
          title="필터, 정렬, 컬럼 제어까지 포함한 상세 리뷰 분석 작업대"
          description="현재 앱 컨텍스트의 비공개 리뷰 피드를 불러와 우선순위·카테고리·키워드 기준으로 정리했습니다. 행 단위 상세 다이얼로그에서 AI 요약과 원문을 함께 검토할 수 있습니다."
          status={`${items.length.toLocaleString()} visible · page ${page}`}
          meta={`${selection.appId} · ${selection.country.toUpperCase()}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={totalFilterCount > 0 ? 'default' : 'secondary'}>{totalFilterCount} active filters</Badge>
              <Button variant="outline" onClick={resetFilters}>
                초기화
              </Button>
            </div>
          }
        />

        {error ? (
          <Card className="border-destructive/30">
            <CardContent className="p-4 text-sm text-destructive" role="alert">
              {error}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <ListFilter className="size-5 text-primary" />
                  조회 컨트롤
                </CardTitle>
                <CardDescription>필터와 테이블 구성 옵션을 탭 단위로 분리했습니다.</CardDescription>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <Columns3 className="size-4" />
                    빠른 컬럼 토글
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {columnOrder.map((key) => {
                    const isOnlyVisible = columnVisibility[key] && activeColumnCount === 1;
                    return (
                      <DropdownMenuCheckboxItem
                        key={key}
                        checked={columnVisibility[key]}
                        disabled={isOnlyVisible}
                        onCheckedChange={() => toggleColumn(key)}
                      >
                        {COLUMN_BY_KEY[key].label}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="filters" className="space-y-5">
              <TabsList>
                <TabsTrigger value="filters">Filters</TabsTrigger>
                <TabsTrigger value="layout">Layout</TabsTrigger>
              </TabsList>

              <TabsContent value="filters" className="space-y-4">
                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-2 xl:col-span-2">
                    <Label htmlFor="review-search">검색어</Label>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="review-search"
                        value={searchKeyword}
                        onChange={(event) => setSearchKeyword(event.target.value)}
                        placeholder="작성자, 요약, 유형, 본문"
                        className="pl-9"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>별점</Label>
                    <Select value={ratingFilter} onValueChange={(value) => setRatingFilter(value as typeof ratingFilter)}>
                      <SelectTrigger>
                        <SelectValue placeholder="전체" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">전체</SelectItem>
                        <SelectItem value="5">5점</SelectItem>
                        <SelectItem value="4">4점</SelectItem>
                        <SelectItem value="3">3점</SelectItem>
                        <SelectItem value="2">2점</SelectItem>
                        <SelectItem value="1">1점</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>우선순위</Label>
                    <Select value={priorityFilter} onValueChange={(value) => setPriorityFilter(value as typeof priorityFilter)}>
                      <SelectTrigger>
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

                  <div className="space-y-2">
                    <Label>유형</Label>
                    <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                      <SelectTrigger>
                        <SelectValue placeholder="전체" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">전체</SelectItem>
                        {categoryOptions.map((category) => (
                          <SelectItem key={category} value={category}>
                            {category}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>정렬 기준</Label>
                    <Select value={sortKey} onValueChange={(value) => setSortKey(value as PrivateReviewSortKey)}>
                      <SelectTrigger>
                        <SelectValue placeholder="정렬 기준" />
                      </SelectTrigger>
                      <SelectContent>
                        {REVIEW_COLUMNS.map((column) => (
                          <SelectItem key={column.key} value={column.key}>
                            {column.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>정렬 방향</Label>
                    <Select value={sortDirection} onValueChange={(value) => setSortDirection(value as 'asc' | 'desc')}>
                      <SelectTrigger>
                        <SelectValue placeholder="정렬 방향" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="desc">내림차순</SelectItem>
                        <SelectItem value="asc">오름차순</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>페이지 크기</Label>
                    <Select value={String(limit)} onValueChange={(value) => setLimit(Number(value) as 10 | 25 | 50)}>
                      <SelectTrigger>
                        <SelectValue placeholder="페이지 크기" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="25">25</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="layout" className="space-y-3">
                {columnOrder.map((key, index) => {
                  const column = COLUMN_BY_KEY[key];
                  const isOnlyVisible = columnVisibility[key] && activeColumnCount === 1;
                  return (
                    <div key={key} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/35 px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{column.label}</p>
                        <p className="text-xs text-muted-foreground">순서 {index + 1}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant={columnVisibility[key] ? 'secondary' : 'ghost'} size="sm" onClick={() => toggleColumn(key)} disabled={isOnlyVisible}>
                          {columnVisibility[key] ? 'Visible' : 'Hidden'}
                        </Button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="sm" onClick={() => moveColumn(key, 'up')} disabled={index === 0}>
                              <ArrowUp className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>앞으로 이동</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => moveColumn(key, 'down')}
                              disabled={index === columnOrder.length - 1}
                            >
                              <ArrowDown className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>뒤로 이동</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <MessageSquareText className="size-5 text-primary" />
                  Review feed
                </CardTitle>
                <CardDescription>우선순위·카테고리·요약을 함께 읽는 데이터 테이블입니다.</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{items.length.toLocaleString()} items</Badge>
                <Badge variant={hasNext ? 'default' : 'outline'}>{hasNext ? 'Next page available' : 'End of page'}</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/35 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline">page {page}</Badge>
                <Badge variant="outline">limit {limit}</Badge>
                <span className="inline-flex items-center gap-2">
                  <ArrowUpDown className="size-4" />
                  {COLUMN_BY_KEY[sortKey].label} / {sortDirection}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => setPage((previous) => Math.max(1, previous - 1))} disabled={loading || page <= 1}>
                  이전
                </Button>
                <Button variant="outline" onClick={() => setPage((previous) => previous + 1)} disabled={loading || !hasNext}>
                  다음
                </Button>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/35">
              <div className="overflow-x-auto">
                <Table className="min-w-[940px]">
                  <TableHeader>
                    <TableRow className="bg-card/90 hover:bg-card/90">
                      {visibleColumns.map((column) => (
                        <TableHead key={column.key} className="sticky top-0 bg-card/95 backdrop-blur-xl">
                          {column.label}
                        </TableHead>
                      ))}
                      <TableHead className="sticky top-0 bg-card/95 text-right backdrop-blur-xl">Open</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 6 }).map((_, index) => (
                        <TableRow key={`loading-${index}`}>
                          {visibleColumns.map((column) => (
                            <TableCell key={`${column.key}-${index}`}>
                              <div className="h-4 w-full animate-pulse rounded-full bg-muted/70" />
                            </TableCell>
                          ))}
                          <TableCell className="text-right">
                            <div className="ml-auto h-8 w-20 animate-pulse rounded-full bg-muted/70" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : items.length > 0 ? (
                      items.map((item) => (
                        <TableRow key={item.review_id}>
                          {visibleColumns.map((column) => (
                            <TableCell key={`${item.review_id}-${column.key}`}>{column.render(item)}</TableCell>
                          ))}
                          <TableCell className="text-right">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="sm" onClick={() => setSelectedReview(item)}>
                                  <Eye className="size-4" />
                                  열기
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>원문/AI 요약 상세 보기</TooltipContent>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={visibleColumns.length + 1} className="py-14 text-center text-sm text-muted-foreground">
                          조회 조건에 맞는 리뷰가 없습니다.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
        </Card>

        <AnimatePresence>
          {selectedReview ? (
            <Dialog open={Boolean(selectedReview)} onOpenChange={(open) => !open && setSelectedReview(null)}>
              <DialogContent>
                <DialogHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={PRIORITY_VARIANT[selectedReview.priority]}>{selectedReview.priority}</Badge>
                    <Badge variant="outline">{selectedReview.category}</Badge>
                    <Badge variant="outline">{selectedReview.rating} / 5</Badge>
                  </div>
                  <DialogTitle>{selectedReview.author || 'Unknown author'}</DialogTitle>
                  <DialogDescription>
                    {new Date(selectedReview.reviewed_at).toLocaleString()} · {selectedReview.app_store_id} · {selectedReview.country.toUpperCase()}
                  </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4">
                  <div className="rounded-2xl border border-border/70 bg-background/35 p-4">
                    <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">AI summary</p>
                    <p className="mt-3 text-base font-medium text-foreground">{selectedReview.summary}</p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      confidence {selectedReview.confidence != null ? selectedReview.confidence.toFixed(2) : 'n/a'}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-border/70 bg-background/35 p-4">
                    <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Original review</p>
                    <p className="mt-3 whitespace-pre-wrap text-sm text-foreground">{selectedReview.content || '본문 없음'}</p>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          ) : null}
        </AnimatePresence>
      </div>
    </TooltipProvider>
  );
}
