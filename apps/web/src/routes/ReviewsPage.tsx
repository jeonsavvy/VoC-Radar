import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { getCategories, getPrivateReviews } from '../lib/api';
import { getAccessToken } from '../lib/auth';
import type { AppSelection } from '../lib/appSelection';
import type { PrivateReviewItem, PrivateReviewSortKey } from '../types';

type Props = {
  loggedIn: boolean;
  selection: AppSelection;
};

const REVIEW_COLUMNS = [
  {
    key: 'reviewed_at',
    label: '작성일',
    render: (item: PrivateReviewItem) => new Date(item.reviewed_at).toLocaleDateString(),
  },
  {
    key: 'author',
    label: '작성자',
    render: (item: PrivateReviewItem) => item.author,
  },
  {
    key: 'rating',
    label: '별점',
    render: (item: PrivateReviewItem) => item.rating,
  },
  {
    key: 'priority',
    label: '우선순위',
    render: (item: PrivateReviewItem) => item.priority,
  },
  {
    key: 'category',
    label: '유형',
    render: (item: PrivateReviewItem) => item.category,
  },
  {
    key: 'summary',
    label: '요약',
    render: (item: PrivateReviewItem) => item.summary,
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
  const [columnOrder, setColumnOrder] = useState<ReviewColumnKey[]>(DEFAULT_COLUMN_ORDER);
  const [columnVisibility, setColumnVisibility] =
    useState<Record<ReviewColumnKey, boolean>>(DEFAULT_COLUMN_VISIBILITY);
  const latestRequestRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchKeyword.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [searchKeyword]);

  useEffect(() => {
    setPage(1);
  }, [
    selection.appId,
    selection.country,
    limit,
    sortKey,
    sortDirection,
    ratingFilter,
    priorityFilter,
    categoryFilter,
    debouncedSearch,
  ]);

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
          if (ratingFilter !== 'all' && item.rating !== Number(ratingFilter)) {
            return false;
          }
          if (priorityFilter !== 'all' && item.priority !== priorityFilter) {
            return false;
          }
          if (categoryFilter !== 'all' && item.category !== categoryFilter) {
            return false;
          }
          if (!debouncedSearch) {
            return true;
          }
          const normalizedKeyword = debouncedSearch.toLowerCase();
          const searchable = [item.author, item.summary, item.category, item.content].join(' ').toLowerCase();
          return searchable.includes(normalizedKeyword);
        });

        setItems(verifiedItems);
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

    load();

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
    () =>
      columnOrder
        .map((key) => COLUMN_BY_KEY[key])
        .filter((column) => columnVisibility[column.key]),
    [columnOrder, columnVisibility],
  );

  const activeColumnCount = Object.values(columnVisibility).filter(Boolean).length;

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

  if (!loggedIn) {
    return <Navigate to="/login" replace />;
  }

  return (
    <section className="panel" aria-labelledby="review-heading">
      <h2 id="review-heading">상세 리뷰 (인증 사용자 전용)</h2>

      {loading && <p>불러오는 중...</p>}
      {error && <p className="error">{error}</p>}

      <div className="review-controls" aria-label="리뷰 조회 설정">
        <div className="review-filter-grid">
          <label className="review-field">
            <span>검색어</span>
            <input
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="작성자, 요약, 유형, 본문"
            />
          </label>

          <label className="review-field">
            <span>별점</span>
            <select value={ratingFilter} onChange={(event) => setRatingFilter(event.target.value as typeof ratingFilter)}>
              <option value="all">전체</option>
              <option value="5">5점</option>
              <option value="4">4점</option>
              <option value="3">3점</option>
              <option value="2">2점</option>
              <option value="1">1점</option>
            </select>
          </label>

          <label className="review-field">
            <span>우선순위</span>
            <select
              value={priorityFilter}
              onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)}
            >
              <option value="all">전체</option>
              <option value="Critical">Critical</option>
              <option value="High">High</option>
              <option value="Normal">Normal</option>
            </select>
          </label>

          <label className="review-field">
            <span>유형</span>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="all">전체</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>

          <label className="review-field">
            <span>정렬 기준</span>
            <select value={sortKey} onChange={(event) => setSortKey(event.target.value as PrivateReviewSortKey)}>
              {REVIEW_COLUMNS.map((column) => (
                <option key={column.key} value={column.key}>
                  {column.label}
                </option>
              ))}
            </select>
          </label>

          <label className="review-field">
            <span>정렬 방향</span>
            <select value={sortDirection} onChange={(event) => setSortDirection(event.target.value as 'asc' | 'desc')}>
              <option value="desc">내림차순</option>
              <option value="asc">오름차순</option>
            </select>
          </label>

          <label className="review-field">
            <span>페이지 크기</span>
            <select value={limit} onChange={(event) => setLimit(Number(event.target.value) as 10 | 25 | 50)}>
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
          </label>
        </div>

        <fieldset className="review-column-config">
          <legend>컬럼 표시/순서 설정</legend>
          <p className="muted">플랫폼 이용자가 상세 리뷰 컬럼을 자유롭게 켜고 끄거나 순서를 조정할 수 있습니다.</p>
          <ul className="column-setting-list">
            {columnOrder.map((key, index) => {
              const column = COLUMN_BY_KEY[key];
              const isOnlyVisible = columnVisibility[key] && activeColumnCount === 1;
              return (
                <li key={key}>
                  <label className="column-toggle">
                    <input
                      type="checkbox"
                      checked={columnVisibility[key]}
                      onChange={() => toggleColumn(key)}
                      disabled={isOnlyVisible}
                    />
                    <span>{column.label}</span>
                  </label>

                  <div className="column-order-actions">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => moveColumn(key, 'up')}
                      disabled={index === 0}
                      aria-label={`${column.label} 컬럼을 앞으로 이동`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => moveColumn(key, 'down')}
                      disabled={index === columnOrder.length - 1}
                      aria-label={`${column.label} 컬럼을 뒤로 이동`}
                    >
                      ↓
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>
      </div>

      <div className="review-pagination">
        <button
          type="button"
          className="ghost-button"
          onClick={() => setPage((previous) => Math.max(1, previous - 1))}
          disabled={loading || page <= 1}
        >
          이전
        </button>
        <p className="muted review-result-count">
          {page}페이지 · 현재 {items.length.toLocaleString()}건
        </p>
        <button
          type="button"
          className="ghost-button"
          onClick={() => setPage((previous) => previous + 1)}
          disabled={loading || !hasNext}
        >
          다음
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {visibleColumns.map((column) => (
                <th key={column.key} scope="col">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.review_id}>
                {visibleColumns.map((column) => (
                  <td key={`${item.review_id}-${column.key}`}>{column.render(item)}</td>
                ))}
              </tr>
            ))}
            {!loading && items.length === 0 && !error && (
              <tr>
                <td colSpan={Math.max(1, visibleColumns.length)}>조회 조건에 맞는 리뷰가 없습니다.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
