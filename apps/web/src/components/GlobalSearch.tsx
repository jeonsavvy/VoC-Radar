import { FormEvent, KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { useNavigate } from 'react-router';
import { AppArtwork } from '@/components/AppArtwork';
import { discoverApps } from '@/lib/api';
import { parseAppIdentity, reportPath } from '@/lib/appIdentity';
import { DEFAULT_COUNTRY } from '@/lib/config';
import type { DiscoveryItem } from '@/types';

type Props = {
  country?: string;
  variant?: 'compact' | 'hero';
  autoFocus?: boolean;
  onNavigate?: () => void;
};

export function moveSearchResultIndex(current: number, count: number, direction: 'next' | 'previous') {
  if (count <= 0) return -1;
  if (direction === 'next') return current < 0 || current >= count - 1 ? 0 : current + 1;
  return current <= 0 || current >= count ? count - 1 : current - 1;
}

export function getOwnedSearchResult(
  query: string,
  resultQuery: string | null,
  results: DiscoveryItem[],
  index = 0,
) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || normalizedQuery !== resultQuery) return null;
  return results[index] ?? null;
}

export function GlobalSearch({ country = DEFAULT_COUNTRY, variant = 'compact', autoFocus = false, onNavigate }: Props) {
  const navigate = useNavigate();
  const listId = useId();
  const requestSequence = useRef(0);
  const [query, setQuery] = useState('');
  const [resultQuery, setResultQuery] = useState<string | null>(null);
  const [results, setResults] = useState<DiscoveryItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setResultQuery(null);
      setActiveIndex(-1);
      setLoading(false);
      setOpen(false);
      setError(null);
      return;
    }

    const timer = window.setTimeout(() => {
      if (requestId !== requestSequence.current) return;
      setLoading(true);
      discoverApps(trimmed, country)
        .then((response) => {
          if (requestId !== requestSequence.current) return;
          setResults(response.data);
          setResultQuery(trimmed);
          setActiveIndex(-1);
          setOpen(true);
          setError(response.data.length === 0 ? '일치하는 앱을 찾지 못했습니다.' : null);
        })
        .catch(() => {
          if (requestId !== requestSequence.current) return;
          setResults([]);
          setResultQuery(trimmed);
          setActiveIndex(-1);
          setOpen(true);
          setError('앱 검색에 실패했습니다. 잠시 후 다시 시도하세요.');
        })
        .finally(() => {
          if (requestId === requestSequence.current) setLoading(false);
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      if (requestId === requestSequence.current) requestSequence.current += 1;
    };
  }, [country, query]);

  const goToApp = (appId: string, appCountry = country) => {
    requestSequence.current += 1;
    setOpen(false);
    setQuery('');
    setResults([]);
    setResultQuery(null);
    setActiveIndex(-1);
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

    const ownedResult = getOwnedSearchResult(query, resultQuery, results);
    if (ownedResult) {
      goToApp(ownedResult.appStoreId, ownedResult.country);
      return;
    }

    setOpen(true);
    setActiveIndex(-1);
    setError('앱 이름, App Store URL 또는 숫자 ID를 입력하세요.');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const ownedResults = query.trim() === resultQuery ? results : [];

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (ownedResults.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) =>
        moveSearchResultIndex(current, ownedResults.length, event.key === 'ArrowDown' ? 'next' : 'previous'),
      );
      return;
    }

    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (event.key === 'Enter' && open && activeIndex >= 0) {
      const activeResult = getOwnedSearchResult(query, resultQuery, results, activeIndex);
      if (!activeResult) return;
      event.preventDefault();
      goToApp(activeResult.appStoreId, activeResult.country);
    }
  };

  const activeDescendant = open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;

  return (
    <div className={`global-search global-search--${variant}`}>
      <form role="search" onSubmit={submit} className="global-search__form">
        <Search aria-hidden="true" className="global-search__icon" />
        <input
          role="combobox"
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => {
            requestSequence.current += 1;
            setQuery(event.target.value);
            setResults([]);
            setResultQuery(null);
            setActiveIndex(-1);
            setLoading(false);
            setOpen(false);
            setError(null);
          }}
          onFocus={() => {
            if (query.trim() === resultQuery && (results.length > 0 || error)) setOpen(true);
          }}
          onBlur={() => window.setTimeout(() => {
            setOpen(false);
            setActiveIndex(-1);
          }, 120)}
          onKeyDown={handleKeyDown}
          aria-label="앱 검색"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls={listId}
          aria-expanded={open}
          aria-activedescendant={activeDescendant}
          placeholder={variant === 'hero' ? '앱 이름, App Store URL 또는 ID' : '앱 검색'}
        />
        <button type="submit" aria-label="검색 결과 열기">
          {loading ? <span className="search-spinner" aria-label="검색 중" /> : <ArrowRight aria-hidden="true" />}
        </button>
      </form>

      {open ? (
        <div id={listId} role="listbox" aria-busy={loading} className="global-search__results">
          {results.map((item, index) => (
            <button
              id={`${listId}-option-${index}`}
              key={`${item.appStoreId}-${item.country}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => goToApp(item.appStoreId, item.country)}
              className="search-result"
            >
              <AppArtwork
                artworkUrl={item.artworkUrl}
                appName={item.appName}
                appStoreId={item.appStoreId}
                country={item.country}
              />
              <span className="search-result__copy">
                <strong>{item.appName || `App ${item.appStoreId}`}</strong>
                <small>{item.developerName || `${item.appStoreId} · ${item.country.toUpperCase()}`}</small>
              </span>
              <span className={item.analyzed ? 'status-dot status-dot--ready' : 'status-dot'}>
                {item.analyzed ? '분석됨' : '미분석'}
              </span>
            </button>
          ))}
          {error ? <p className="search-result__message" role="status">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
