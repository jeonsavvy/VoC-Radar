import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Search } from 'lucide-react';
import { searchApps } from '@/lib/api';
import { isValidAppId, normalizeCountry, type AppSelection } from '@/lib/appSelection';
import type { AppSearchItem } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface AppSearchPickerProps {
  selection: AppSelection;
  appName?: string | null;
  onSelect: (next: AppSelection, meta?: { appName?: string | null }) => void;
  className?: string;
  compact?: boolean;
}

export function AppSearchPicker({ selection, appName, onSelect, className, compact = false }: AppSearchPickerProps) {
  const [query, setQuery] = useState(appName || selection.appId);
  const [country, setCountry] = useState(selection.country);
  const [items, setItems] = useState<AppSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setQuery(appName || selection.appId);
    setCountry(selection.country);
  }, [appName, selection.appId, selection.country]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setItems([]);
      return;
    }

    const timer = setTimeout(() => {
      setLoading(true);
      searchApps(query.trim(), 8)
        .then((response) => setItems(response.data))
        .catch(() => setItems([]))
        .finally(() => setLoading(false));
    }, 180);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, []);

  const helperText = useMemo(() => {
    if (isValidAppId(query.trim())) {
      return '앱 ID 직접 입력으로도 적용할 수 있습니다.';
    }
    return '앱명 또는 App Store ID로 검색하세요.';
  }, [query]);

  const applyManualSelection = () => {
    if (!isValidAppId(query.trim())) {
      return;
    }

    onSelect(
      {
        appId: query.trim(),
        country: normalizeCountry(country),
      },
      { appName: null },
    );
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <div className={cn('grid gap-2', compact ? 'lg:grid-cols-[minmax(0,1fr)_90px_auto]' : 'md:grid-cols-[minmax(0,1fr)_96px_auto]')}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="앱명 또는 App Store ID 검색"
            className="pl-9"
            aria-label="앱 검색"
          />
        </div>
        <Input
          value={country}
          onChange={(event) => setCountry(event.target.value)}
          maxLength={2}
          placeholder="국가"
          aria-label="국가 코드"
        />
        <Button type="button" variant="outline" onClick={applyManualSelection}>
          적용
        </Button>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">{helperText}</p>

      {open ? (
        <div className="absolute z-30 mt-2 w-full rounded-xl border border-border bg-popover shadow-md">
          {loading ? (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              검색 중...
            </div>
          ) : items.length > 0 ? (
            <ul className="max-h-80 overflow-y-auto py-2">
              {items.map((item) => (
                <li key={`${item.app_store_id}-${item.country}`}>
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-accent"
                    onClick={() => {
                      onSelect(
                        {
                          appId: item.app_store_id,
                          country: normalizeCountry(item.country),
                        },
                        { appName: item.app_name },
                      );
                      setQuery(item.app_name || item.app_store_id);
                      setCountry(item.country);
                      setOpen(false);
                    }}
                  >
                    <div>
                      <p className="text-sm font-semibold text-foreground">{item.app_name || '이름 미확인 앱'}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.app_store_id} · {item.country.toUpperCase()}
                      </p>
                    </div>
                    <span className="kbd-chip">{item.country.toUpperCase()}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-3 text-sm text-muted-foreground">검색 결과가 없습니다.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
