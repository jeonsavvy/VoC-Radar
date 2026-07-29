import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { AppArtwork } from '@/components/AppArtwork';
import { GlobalSearch } from '@/components/GlobalSearch';
import { discoverApps } from '@/lib/api';
import { reportPath } from '@/lib/appIdentity';
import { DEFAULT_COUNTRY } from '@/lib/config';
import type { DiscoveryItem } from '@/types';

export function ExplorePage() {
  const [recent, setRecent] = useState<DiscoveryItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setState('loading');
    discoverApps('', DEFAULT_COUNTRY, 6)
      .then((response) => {
        if (!active) return;
        setRecent(response.data);
        setState('ready');
      })
      .catch(() => {
        if (!active) return;
        setRecent([]);
        setState('error');
      });
    return () => { active = false; };
  }, [reloadKey]);

  return (
    <div className="explore-page">
      <section className="explore-hero" aria-labelledby="explore-title">
        <h1 id="explore-title">앱 리뷰 리포트</h1>
        <GlobalSearch country={DEFAULT_COUNTRY} variant="hero" />
      </section>

      <section className="explore-section" aria-labelledby="recent-title">
        <div className="section-heading">
          <h2 id="recent-title">최근 분석</h2>
        </div>
        {state === 'loading' ? (
          <div className="quiet-empty">불러오는 중</div>
        ) : state === 'error' ? (
          <div className="quiet-empty" role="alert">
            최근 분석을 불러오지 못했습니다. 현재 목록은 최신이 아닐 수 있습니다.
            <button type="button" onClick={() => setReloadKey((value) => value + 1)}>다시 시도</button>
          </div>
        ) : recent.length > 0 ? (
          <div className="recent-apps">
            {recent.map((app) => (
              <Link key={`${app.appStoreId}-${app.country}`} to={reportPath(app.appStoreId, app.country)} className="recent-app-row">
                <AppArtwork artworkUrl={app.artworkUrl} appName={app.appName} />
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
          <div className="quiet-empty">게시된 리포트가 없습니다.</div>
        )}
      </section>

    </div>
  );
}
