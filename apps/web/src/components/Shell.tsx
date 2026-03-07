import { useEffect, useMemo, useState } from 'react';
import { BellRing, LogIn, LogOut } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { AppSearchPicker } from '@/components/app-search-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getPublicAppMeta, getPublicApps, getRuns } from '@/lib/api';
import type { AppSelection } from '@/lib/appSelection';
import { cn } from '@/lib/utils';
import type { PublicAppItem, RunSummaryItem } from '@/types';

type Props = {
  loggedIn: boolean;
  onSignOut: () => void;
  selection: AppSelection;
  onSelectionChange: (next: AppSelection) => void;
};

const NAV_ITEMS = [
  { to: '/', label: '대시보드' },
  { to: '/analyze', label: '수집 실행' },
  { to: '/reviews', label: '원문 리뷰' },
] as const;

const ROUTE_HINT: Record<string, string> = {
  '/': '최근 30일 App Store 리뷰를 요약해 보여줍니다.',
  '/analyze': 'App Store 리뷰 수집을 실행합니다.',
  '/reviews': '원문 리뷰를 필터링해 확인합니다.',
  '/login': '로그인 상태를 관리합니다.',
};

function formatRunStatus(run: RunSummaryItem | null) {
  if (!run) {
    return '최근 실행 이력이 없습니다.';
  }

  if (run.status === 'published') {
    return `마지막 반영 ${new Date(run.published_at || run.updated_at).toLocaleString()}`;
  }

  if (run.status === 'failed') {
    return `최근 실행 실패 ${new Date(run.updated_at).toLocaleString()}`;
  }

  return `최근 실행 ${new Date(run.updated_at).toLocaleString()}`;
}

export function Shell({ loggedIn, onSignOut, selection, onSelectionChange }: Props) {
  const location = useLocation();
  const [appName, setAppName] = useState<string | null>(null);
  const [recentApps, setRecentApps] = useState<PublicAppItem[]>([]);
  const [latestRun, setLatestRun] = useState<RunSummaryItem | null>(null);

  useEffect(() => {
    let mounted = true;

    getPublicAppMeta(selection.appId, selection.country)
      .then((response) => {
        if (mounted) {
          setAppName(response.data.app_name?.trim() || null);
        }
      })
      .catch(() => {
        if (mounted) {
          setAppName(null);
        }
      });

    getRuns(selection.appId, selection.country, 1)
      .then((response) => {
        if (mounted) {
          setLatestRun(response.data[0] || null);
        }
      })
      .catch(() => {
        if (mounted) {
          setLatestRun(null);
        }
      });

    return () => {
      mounted = false;
    };
  }, [selection.appId, selection.country]);

  useEffect(() => {
    let mounted = true;

    getPublicApps(6)
      .then((response) => {
        if (mounted) {
          setRecentApps(response.data);
        }
      })
      .catch(() => {
        if (mounted) {
          setRecentApps([]);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const currentNavLabel = useMemo(() => NAV_ITEMS.find((item) => item.to === location.pathname)?.label ?? '로그인', [location.pathname]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <img src="/assets/voc-radar-mark.svg" alt="VoC-Radar" className="size-11 rounded-xl border border-border bg-card p-1.5" />
              <div>
                <p className="text-sm font-semibold text-foreground">VoC-Radar</p>
                <p className="mt-1 text-xs text-muted-foreground">App Store 리뷰 분석</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{currentNavLabel}</Badge>
              <Badge variant={loggedIn ? 'success' : 'secondary'}>{loggedIn ? '로그인됨' : '공개 모드'}</Badge>
              {loggedIn ? (
                <Button variant="outline" onClick={onSignOut}>
                  <LogOut className="size-4" />
                  로그아웃
                </Button>
              ) : (
                <Button asChild>
                  <NavLink to="/login">
                    <LogIn className="size-4" />
                    로그인
                  </NavLink>
                </Button>
              )}
            </div>
          </div>

          <div className="grid gap-4 rounded-2xl border border-border bg-card p-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {NAV_ITEMS.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'rounded-full px-3 py-2 text-sm font-medium transition-colors',
                        isActive ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>

              <AppSearchPicker
                selection={selection}
                appName={appName}
                onSelect={(next, meta) => {
                  onSelectionChange(next);
                  setAppName(meta?.appName?.trim() || null);
                }}
              />

              <div className="flex flex-wrap gap-2">
                {recentApps.map((item) => {
                  const isSelected = item.app_store_id === selection.appId && item.country === selection.country;
                  return (
                    <button
                      key={`${item.app_store_id}-${item.country}`}
                      type="button"
                      onClick={() =>
                        onSelectionChange({
                          appId: item.app_store_id,
                          country: item.country,
                        })
                      }
                      className={cn(
                        'rounded-full border px-3 py-2 text-xs font-medium transition-colors',
                        isSelected ? 'border-primary bg-primary/8 text-primary' : 'border-border bg-background hover:bg-accent',
                      )}
                    >
                      {(item.app_name || `앱 ${item.app_store_id}`).slice(0, 18)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 rounded-xl bg-panel p-4">
              <div>
                <p className="text-xs font-medium text-muted-foreground">현재 선택 앱</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{appName || `앱 ${selection.appId}`}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selection.appId} · {selection.country.toUpperCase()}
                </p>
              </div>

              <div className="grid gap-2 rounded-xl border border-border bg-background px-3 py-3">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <BellRing className="size-4 text-primary" />
                  최근 반영 상태
                </div>
                <p className="text-sm text-muted-foreground">{formatRunStatus(latestRun)}</p>
                <p className="text-xs text-muted-foreground">{ROUTE_HINT[location.pathname] || ROUTE_HINT['/']}</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
        <main className="pb-10">
          <Outlet />
        </main>
        <footer className="border-t border-border pt-5 text-center text-sm text-muted-foreground">© VoC-Radar</footer>
      </div>
    </div>
  );
}
