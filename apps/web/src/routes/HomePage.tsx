import { useEffect, useMemo, useState } from 'react';
import { getCategories, getOverview } from '../lib/api';
import type { AppSelection } from '../lib/appSelection';
import type { PublicCategoryPoint, PublicOverview } from '../types';

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

const CATEGORY_CHART_COLORS = ['#6a7bff', '#3ad9ff', '#6ce2a5', '#ffcc66', '#ff82ab', '#a58bff'];

export function HomePage({ selection }: Props) {
  const [overview, setOverview] = useState<PublicOverview | null>(null);
  const [categories, setCategories] = useState<PublicCategoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError(null);

    Promise.all([getOverview(selection.appId, selection.country), getCategories(selection.appId, selection.country)])
      .then(([overviewResult, categoriesResult]) => {
        if (!active) {
          return;
        }
        setOverview(overviewResult.data);
        setCategories(categoriesResult.data);
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

  const topCategories = categories.slice(0, 5);
  const otherCategories = categories.slice(5);

  const categorySlices = useMemo(() => {
    const slices = topCategories.map((item, index) => ({
      category: item.category,
      totalReviews: item.total_reviews,
      sharePercent: Math.max(0, item.share_percent),
      color: CATEGORY_CHART_COLORS[index % CATEGORY_CHART_COLORS.length],
    }));

    const otherShare = otherCategories.reduce((sum, item) => sum + Math.max(0, item.share_percent), 0);
    if (otherShare > 0.01) {
      slices.push({
        category: '기타',
        totalReviews: otherCategories.reduce((sum, item) => sum + item.total_reviews, 0),
        sharePercent: otherShare,
        color: CATEGORY_CHART_COLORS[slices.length % CATEGORY_CHART_COLORS.length],
      });
    }

    return slices;
  }, [topCategories, otherCategories]);

  const categoryPieBackground = useMemo(() => {
    if (categorySlices.length === 0) {
      return 'conic-gradient(#1a2440 0 100%)';
    }

    let current = 0;
    const stops: string[] = [];

    categorySlices.forEach((slice) => {
      const start = current;
      current = Math.min(100, current + slice.sharePercent);
      stops.push(`${slice.color} ${start.toFixed(2)}% ${current.toFixed(2)}%`);
    });

    if (current < 100) {
      stops.push(`#1a2440 ${current.toFixed(2)}% 100%`);
    }

    return `conic-gradient(${stops.join(', ')})`;
  }, [categorySlices]);

  const sampledReviewCount = overview?.total_reviews ?? 0;
  const sampledCriticalCount = overview?.critical_count ?? 0;
  const sampledAverageRating = overview?.average_rating ?? 0;

  return (
    <div className="story-grid">
      <section className="hero-focus" aria-labelledby="hero-title">
        <div>
          <p className="eyebrow">External Report</p>
          <h2 id="hero-title" className="kinetic-headline">
            목소리를 <span>즉시</span> 읽고,
            <br />
            우선순위를 <span>정렬</span>합니다.
          </h2>
          <p className="lead-copy">누적 지표와 최근 분석 결과를 한 화면에서 확인하세요.</p>
        </div>
      </section>

      <section className="panel" aria-labelledby="dashboard-title">
        <h3 id="dashboard-title">운영 대시보드</h3>

        {error && <p className="error">{error}</p>}

        {!loading && !error && overview && (
          <>
            <dl className="metric-grid">
              <div>
                <dt>최근 30일 리뷰 수</dt>
                <dd>{sampledReviewCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>최근 30일 Critical</dt>
                <dd>{sampledCriticalCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>최근 30일 평균 평점</dt>
                <dd>{sampledAverageRating.toFixed(2)}</dd>
              </div>
            </dl>

            <div className="dashboard-grid">
              <article className="story-section">
                <h4>최근 30일 Top 카테고리</h4>
                {categorySlices.length > 0 ? (
                  <div className="category-chart">
                    <div
                      className="pie-chart"
                      role="img"
                      aria-label="최근 30일 Top 카테고리 원형 그래프"
                      style={{ background: categoryPieBackground }}
                    />

                    <ul className="chart-legend">
                      {categorySlices.map((slice) => (
                        <li key={slice.category}>
                          <span className="legend-label">
                            <span className="legend-dot" style={{ background: slice.color }} aria-hidden="true" />
                            {slice.category}
                          </span>
                          <span className="legend-value">
                            {slice.totalReviews.toLocaleString()}건 ({slice.sharePercent.toFixed(1)}%)
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="muted">카테고리 데이터가 없습니다.</p>
                )}
              </article>

              <article className="story-section">
                <ul className="bullet-list">
                  <li>최신 집계 시각: {overview.last_review_at ? new Date(overview.last_review_at).toLocaleString() : '-'}</li>
                  <li>집계 기준: 최근 30일</li>
                  <li>선택 앱 기준으로 자동 집계</li>
                </ul>
              </article>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
