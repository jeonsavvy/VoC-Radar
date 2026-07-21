import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { GlobalSearch } from '@/components/GlobalSearch';
import { discoverApps } from '@/lib/api';
import { reportPath } from '@/lib/appIdentity';
import type { DiscoveryItem } from '@/types';

export function ExplorePage() {
  const [recent, setRecent] = useState<DiscoveryItem[]>([]);

  useEffect(() => {
    let active = true;
    discoverApps('', 'kr', 6)
      .then((response) => active && setRecent(response.data))
      .catch(() => active && setRecent([]));
    return () => { active = false; };
  }, []);

  return (
    <div className="explore-page">
      <section className="explore-hero" aria-labelledby="explore-title">
        <p className="eyebrow">APP DIRECTORY</p>
        <h1 id="explore-title">앱 리뷰 리포트</h1>
        <p className="explore-hero__description">
          앱 이름, App Store URL 또는 ID로 공개된 분석 결과를 찾습니다.
        </p>
        <GlobalSearch variant="hero" />
        <p className="search-hint">리포트 열람은 공개되며, 신규 분석과 갱신 요청에만 로그인이 필요합니다.</p>
      </section>

      <section className="explore-section" aria-labelledby="recent-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">PUBLIC REPORTS</p>
            <h2 id="recent-title">최근 공개 리포트</h2>
            <p className="section-description">
              고정 추천이 아니라 실제 분석이 최근 게시된 앱입니다.
            </p>
          </div>
        </div>
        {recent.length > 0 ? (
          <div className="recent-apps">
            {recent.map((app) => (
              <Link key={`${app.appStoreId}-${app.country}`} to={reportPath(app.appStoreId, app.country)} className="recent-app-row">
                <span className="app-initial">{app.appName?.[0] || 'A'}</span>
                <span>
                  <strong>{app.appName || `App ${app.appStoreId}`}</strong>
                  <small>{app.appStoreId} · {app.country.toUpperCase()}</small>
                </span>
                <time>{app.lastAnalyzedAt ? new Date(app.lastAnalyzedAt).toLocaleDateString('ko-KR') : '—'}</time>
                <ArrowRight aria-hidden="true" />
              </Link>
            ))}
          </div>
        ) : (
          <div className="quiet-empty">최근 공개 리포트를 불러오는 중이거나 아직 게시된 분석이 없습니다.</div>
        )}
      </section>

    </div>
  );
}
