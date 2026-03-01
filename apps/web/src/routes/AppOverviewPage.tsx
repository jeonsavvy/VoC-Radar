import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getOverview, getPublicAppMeta } from '../lib/api';
import type { AppSelection } from '../lib/appSelection';
import type { PublicOverview } from '../types';

type Props = {
  selection: AppSelection;
};

export function AppOverviewPage({ selection }: Props) {
  const params = useParams();
  const appId = params.appId || selection.appId;
  const country = selection.country;

  const [overview, setOverview] = useState<PublicOverview | null>(null);
  const [appName, setAppName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    setLoading(true);
    setError(null);

    Promise.all([getOverview(appId, country), getPublicAppMeta(appId, country)])
      .then(([overviewResponse, appMetaResponse]) => {
        if (!mounted) {
          return;
        }
        setOverview(overviewResponse.data);
        setAppName(appMetaResponse.data.app_name?.trim() || null);
      })
      .catch((err) => {
        if (!mounted) {
          return;
        }
        setError(err instanceof Error ? err.message : '요약 데이터 조회에 실패했습니다.');
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [appId, country]);

  return (
    <section className="panel" aria-labelledby="app-summary-heading">
      <h2 id="app-summary-heading">앱 요약 리포트</h2>
      <p className="muted">
        앱 이름: <strong>{appName || 'Unknown App'}</strong> · App ID: <code>{appId}</code> · Country:{' '}
        <code>{country}</code>
      </p>

      {loading && <p>불러오는 중...</p>}
      {error && <p className="error">{error}</p>}

      {overview && !loading && !error && (
        <dl className="metric-grid">
          <div>
            <dt>전체 리뷰</dt>
            <dd>{overview.total_reviews.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Critical 건수</dt>
            <dd>{overview.critical_count.toLocaleString()}</dd>
          </div>
          <div>
            <dt>저평점(≤2) 건수</dt>
            <dd>{overview.low_rating_count.toLocaleString()}</dd>
          </div>
          <div>
            <dt>평균 평점</dt>
            <dd>{overview.average_rating.toFixed(2)}</dd>
          </div>
          <div>
            <dt>긍정 비율(4~5)</dt>
            <dd>{overview.positive_ratio.toFixed(1)}%</dd>
          </div>
          <div>
            <dt>마지막 리뷰 시각</dt>
            <dd>{overview.last_review_at ? new Date(overview.last_review_at).toLocaleString() : '-'}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
