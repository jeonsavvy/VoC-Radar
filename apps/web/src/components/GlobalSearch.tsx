import { FormEvent, useEffect, useId, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppArtwork } from '@/components/AppArtwork';
import { discoverApps } from '@/lib/api';
import { parseAppIdentity, reportPath } from '@/lib/appIdentity';
import type { DiscoveryItem } from '@/types';

type Props = {
  country?: string;
  variant?: 'compact' | 'hero';
  autoFocus?: boolean;
  onNavigate?: () => void;
};

export function GlobalSearch({ country = 'kr', variant = 'compact', autoFocus = false, onNavigate }: Props) {
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DiscoveryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setOpen(false);
      setError(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      discoverApps(trimmed, country)
        .then((response) => {
          if (!active) return;
          setResults(response.data);
          setOpen(true);
          setError(response.data.length === 0 ? '일치하는 앱을 찾지 못했습니다.' : null);
        })
        .catch(() => {
          if (!active) return;
          setResults([]);
          setOpen(true);
          setError('앱 검색에 실패했습니다. 잠시 후 다시 시도하세요.');
        })
        .finally(() => active && setLoading(false));
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [country, query]);

  const goToApp = (appId: string, appCountry = country) => {
    setOpen(false);
    setQuery('');
    navigate(reportPath(appId, appCountry));
    onNavigate?.();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseAppIdentity(query, country);
    if (parsed) {
      goToApp(parsed.appId, parsed.country);
      return;
    }
    if (results[0]) {
      goToApp(results[0].appStoreId, results[0].country);
      return;
    }
    setOpen(true);
    setError('앱 이름, App Store URL 또는 숫자 ID를 입력하세요.');
  };

  return (
    <div className={`global-search global-search--${variant}`}>
      <form role="search" onSubmit={submit} className="global-search__form">
        <Search aria-hidden="true" className="global-search__icon" />
        <input
          role="combobox"
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => query.trim().length >= 2 && setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          aria-label="앱 검색"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls={listId}
          aria-expanded={open}
          placeholder={variant === 'hero' ? '앱 이름, App Store URL 또는 ID' : '앱 검색'}
        />
        <button type="submit" aria-label="검색 결과 열기">
          {loading ? <span className="search-spinner" aria-label="검색 중" /> : <ArrowRight aria-hidden="true" />}
        </button>
      </form>

      {open ? (
        <div id={listId} role="listbox" className="global-search__results">
          {results.map((item) => (
            <button
              key={`${item.appStoreId}-${item.country}`}
              type="button"
              role="option"
              aria-selected="false"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => goToApp(item.appStoreId, item.country)}
              className="search-result"
            >
              <AppArtwork artworkUrl={item.artworkUrl} appName={item.appName} />
              <span className="search-result__copy">
                <strong>{item.appName || `App ${item.appStoreId}`}</strong>
                <small>{item.developerName || `${item.appStoreId} · ${item.country.toUpperCase()}`}</small>
              </span>
              <span className={item.analyzed ? 'status-dot status-dot--ready' : 'status-dot'}>
                {item.analyzed ? '분석됨' : '미분석'}
              </span>
            </button>
          ))}
          {error ? <p className="search-result__message">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
