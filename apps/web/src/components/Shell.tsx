import { useEffect, useState } from 'react';
import { BellRing, LogIn, LogOut } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { AppSearchPicker } from '@/components/app-search-picker';
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
  { to: '/reviews', label: '리뷰' },
  { to: '/analyze', label: '수집 실행' },
] as const;

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
  const [appName, setAppName] = useState<string | null>(null);
  const [recentAnalyzedApps, setRecentAnalyzedApps] = useState<PublicAppItem[]>([]);
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

    getPublicApps(20)
      .then(async (response) => {
        const candidates = response.data.slice(0, 20);
        const withRuns = await Promise.all(
          candidates.map(async (item) => {
            try {
              const runsResponse = await getRuns(item.app_store_id, item.country, 1);
              return runsResponse.data.length > 0 ? item : null;
            } catch {
              return null;
            }
          }),
        );

        if (mounted) {
          setRecentAnalyzedApps(withRuns.filter((item): item is PublicAppItem => item !== null).slice(0, 6));
        }
      })
      .catch(() => {
        if (mounted) {
          setRecentAnalyzedApps([]);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <img src="/assets/voc-radar-mark.svg" alt="VoC-Radar" className="size-11 rounded-xl border border-border bg-card p-1.5" />
              <p className="text-sm font-semibold text-foreground">VoC-Radar</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
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
                        isActive
                          ? 'bg-primary text-white shadow-sm'
                          : 'bg-secondary text-secondary-foreground hover:bg-accent',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>

              <AppSearchPicker
                selection={selection}
                onSelect={(next) => {
                  onSelectionChange(next);
                  setAppName(null);
                }}
              />

              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">최근 분석된 앱</p>
                {recentAnalyzedApps.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {recentAnalyzedApps.map((item) => {
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
                            'rounded-full border px-3 py-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                            isSelected
                              ? 'border-primary bg-primary text-white shadow-sm hover:bg-primary/92'
                              : 'border-border bg-background text-foreground hover:border-primary/35 hover:bg-accent',
                          )}
                        >
                          {(item.app_name || `앱 ${item.app_store_id}`).slice(0, 18)}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">최근 분석 완료된 앱이 아직 없습니다.</p>
                )}
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
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
        <main className="pb-10">
          <Outlet />
        </main>
        <footer className="pt-5 text-center text-sm text-muted-foreground">© VoC-Radar</footer>
      </div>
    </div>
  );
}
