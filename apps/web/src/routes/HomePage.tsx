import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getOverview } from '../lib/api';
import type { PublicOverview } from '../types';

const defaultAppId = import.meta.env.VITE_DEFAULT_APP_ID || '1018769995';
const defaultCountry = import.meta.env.VITE_DEFAULT_COUNTRY || 'kr';

export function HomePage() {
  const [overview, setOverview] = useState<PublicOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    setLoading(true);
    getOverview(defaultAppId, defaultCountry)
      .then((result) => {
        if (!active) {
          return;
        }
        setOverview(result.data);
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        setError(err instanceof Error ? err.message : '요약 데이터를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const heroKpis = useMemo(() => {
    if (!overview) {
      return [
        { label: '전체 리뷰', value: '-' },
        { label: 'Critical', value: '-' },
        { label: '평균 평점', value: '-' },
      ];
    }

    return [
      { label: '전체 리뷰', value: overview.total_reviews.toLocaleString() },
      { label: 'Critical', value: overview.critical_count.toLocaleString() },
      { label: '평균 평점', value: overview.average_rating.toFixed(2) },
    ];
  }, [overview]);

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
            VoC Radar는 App Store 리뷰를 수집·분류하고, 공개 리포트와 로그인 기반 상세 분석을 분리해 제공합니다.
          </p>

          <div className="hero-actions">
            <Link to={`/apps/${defaultAppId}`} className="primary-button">
              앱 요약 보기
            </Link>
            <Link to="/reviews" className="ghost-button">
              상세 리뷰(로그인)
            </Link>
          </div>
        </div>

        <aside className="kpi-panel" aria-live="polite">
          {loading && <p>요약 지표를 불러오는 중...</p>}
          {error && <p className="error">{error}</p>}
          {!loading && !error && (
            <ul>
              {heroKpis.map((kpi) => (
                <li key={kpi.label}>
                  <span>{kpi.label}</span>
                  <strong>{kpi.value}</strong>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </section>

      <section className="story-section" aria-labelledby="story-title">
        <h3 id="story-title">리포트 흐름</h3>
        <ol>
          <li>수집: n8n이 App Store 리뷰를 배치 수집</li>
          <li>분석: Gemini로 priority/category/summary 생성</li>
          <li>저장: Supabase upsert로 중복 없는 누적</li>
          <li>공개: Cloudflare Pages/Worker API로 즉시 반영</li>
        </ol>
      </section>
    </div>
  );
}
