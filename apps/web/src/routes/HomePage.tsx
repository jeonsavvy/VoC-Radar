import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCategories, getOverview, getTrends } from '../lib/api';
import type { AppSelection } from '../lib/appSelection';
import type { PublicCategoryPoint, PublicOverview, PublicTrendPoint } from '../types';

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

export function HomePage({ selection }: Props) {
  const [overview, setOverview] = useState<PublicOverview | null>(null);
  const [trends, setTrends] = useState<PublicTrendPoint[]>([]);
  const [categories, setCategories] = useState<PublicCategoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError(null);

    Promise.all([
      getOverview(selection.appId, selection.country),
      getTrends(selection.appId, selection.country),
      getCategories(selection.appId, selection.country),
    ])
      .then(([overviewResult, trendsResult, categoriesResult]) => {
        if (!active) {
          return;
        }
        setOverview(overviewResult.data);
        setTrends(trendsResult.data);
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

  const latestTrend = trends.length > 0 ? trends[trends.length - 1] : null;
  const previousTrend = trends.length > 1 ? trends[trends.length - 2] : null;

  const reviewDelta = useMemo(() => {
    if (!latestTrend || !previousTrend) {
      return null;
    }
    const delta = latestTrend.total_reviews - previousTrend.total_reviews;
    const direction = delta >= 0 ? '증가' : '감소';
    return `전일 대비 ${Math.abs(delta)}건 ${direction}`;
  }, [latestTrend, previousTrend]);

  const topCategories = categories.slice(0, 3);

  return (
    <div className="story-grid">
      <section className="hero split-hero" aria-labelledby="hero-title">
        <div>
          <p className="eyebrow">External Report</p>
          <h2 id="hero-title" className="kinetic-headline">
            고객 목소리를 <span>즉시</span> 읽고,
            <br />
            제품 우선순위를 <span>정렬</span>합니다.
          </h2>
          <p className="lead-copy">
            선택한 앱(<code>{selection.appId}</code> / <code>{selection.country}</code>) 기준으로 누적 리뷰 지표를 바로 확인하세요.
          </p>

          <div className="hero-actions">
            <Link to={`/apps/${selection.appId}`} className="primary-button">
              앱 요약 보기
            </Link>
            <Link to="/analyze" className="ghost-button">
              분석 요청하기
            </Link>
          </div>
        </div>

        <aside className="kpi-panel" aria-live="polite">
          {loading && <p>대시보드 지표를 불러오는 중...</p>}
          {error && <p className="error">{error}</p>}
          {!loading && !error && overview && (
            <ul>
              <li>
                <span>누적 리뷰</span>
                <strong>{overview.total_reviews.toLocaleString()}</strong>
              </li>
              <li>
                <span>Critical</span>
                <strong>{overview.critical_count.toLocaleString()}</strong>
              </li>
              <li>
                <span>평균 평점</span>
                <strong>{overview.average_rating.toFixed(2)}</strong>
              </li>
              <li>
                <span>긍정 비율</span>
                <strong>{overview.positive_ratio.toFixed(1)}%</strong>
              </li>
            </ul>
          )}
        </aside>
      </section>

      <section className="panel" aria-labelledby="dashboard-title">
        <h3 id="dashboard-title">운영 대시보드</h3>

        {error && <p className="error">{error}</p>}

        {!loading && !error && overview && (
          <>
            <dl className="metric-grid">
              <div>
                <dt>저평점(≤2)</dt>
                <dd>{overview.low_rating_count.toLocaleString()}</dd>
              </div>
              <div>
                <dt>최신 리뷰 시각</dt>
                <dd>{overview.last_review_at ? new Date(overview.last_review_at).toLocaleDateString() : '-'}</dd>
              </div>
              <div>
                <dt>최근 일일 리뷰량</dt>
                <dd>{latestTrend ? latestTrend.total_reviews.toLocaleString() : '-'}</dd>
              </div>
              <div>
                <dt>전일 변화</dt>
                <dd>{reviewDelta || '-'}</dd>
              </div>
            </dl>

            <div className="dashboard-grid">
              <article className="story-section">
                <h4>Top 카테고리</h4>
                <ul className="bullet-list">
                  {topCategories.map((item) => (
                    <li key={item.category}>
                      {item.category}: {item.total_reviews.toLocaleString()}건 ({item.share_percent.toFixed(1)}%)
                    </li>
                  ))}
                  {topCategories.length === 0 && <li>카테고리 데이터가 없습니다.</li>}
                </ul>
              </article>

              <article className="story-section">
                <h4>최근 5일 추이</h4>
                <ul className="bullet-list">
                  {trends.slice(-5).map((point) => (
                    <li key={point.bucket_date}>
                      {point.bucket_date}: {point.total_reviews}건 / Critical {point.critical_count}건 / 평점{' '}
                      {point.average_rating.toFixed(2)}
                    </li>
                  ))}
                  {trends.length === 0 && <li>추이 데이터가 없습니다.</li>}
                </ul>
              </article>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
