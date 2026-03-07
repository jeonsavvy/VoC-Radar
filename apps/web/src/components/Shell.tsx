import { FormEvent, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Activity,
  ArrowRight,
  Bot,
  ClipboardList,
  Compass,
  LogIn,
  LogOut,
  Radar,
  Sparkles,
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getPublicAppMeta, getPublicApps } from '@/lib/api';
import { isValidAppId, normalizeCountry, type AppSelection } from '@/lib/appSelection';
import type { PublicAppItem } from '@/types';

type Props = {
  loggedIn: boolean;
  onSignOut: () => void;
  selection: AppSelection;
  onSelectionChange: (next: AppSelection) => void;
};

const NAV_ITEMS = [
  {
    to: '/',
    label: 'Overview',
    description: '제품 체감 지표와 이상 신호를 확인합니다.',
    icon: Radar,
  },
  {
    to: '/analyze',
    label: 'Pipeline',
    description: '수집/분석 큐를 등록하고 파이프라인 상태를 관리합니다.',
    icon: Bot,
  },
  {
    to: '/reviews',
    label: 'Reviews',
    description: '세부 리뷰를 필터링하고 근거 문장을 검토합니다.',
    icon: ClipboardList,
  },
] as const;

const DEFAULT_ROUTE_CONTEXT = {
  eyebrow: 'Signal Desk',
  hint: '공개 리포트용 요약 지표와 추세를 추적합니다.',
};

const ROUTE_CONTEXT: Record<string, { eyebrow: string; hint: string }> = {
  '/': DEFAULT_ROUTE_CONTEXT,
  '/analyze': {
    eyebrow: 'Pipeline Console',
    hint: '작업 큐 등록과 실행 상태를 운영 관점에서 제어합니다.',
  },
  '/reviews': {
    eyebrow: 'Review Workbench',
    hint: '로그인 사용자가 세부 VoC를 정밀하게 읽고 정렬합니다.',
  },
  '/login': {
    eyebrow: 'Access Control',
    hint: '리뷰 상세/분석 요청 권한 접근을 관리합니다.',
  },
};

export function Shell({ loggedIn, onSignOut, selection, onSelectionChange }: Props) {
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const [appIdInput, setAppIdInput] = useState(selection.appId);
  const [countryInput, setCountryInput] = useState(selection.country);
  const [appName, setAppName] = useState<string | null>(null);
  const [recentApps, setRecentApps] = useState<PublicAppItem[]>([]);

  useEffect(() => {
    setAppIdInput(selection.appId);
    setCountryInput(selection.country);
  }, [selection.appId, selection.country]);

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

  const onApplySelection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextAppId = appIdInput.trim();
    if (!isValidAppId(nextAppId)) {
      return;
    }

    onSelectionChange({
      appId: nextAppId,
      country: normalizeCountry(countryInput),
    });
  };

  const currentRoute = useMemo(() => ROUTE_CONTEXT[location.pathname] ?? DEFAULT_ROUTE_CONTEXT, [location.pathname]);
  const activeNav = NAV_ITEMS.find((item) => item.to === location.pathname) || NAV_ITEMS[0];

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6 lg:flex-row lg:gap-6 lg:px-8">
      <aside className="flex w-full flex-col gap-4 lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:w-80 lg:flex-none">
        <Card className="overflow-hidden">
          <CardHeader className="gap-4">
            <div className="flex items-start gap-4">
              <img src="/assets/voc-radar-mark.svg" alt="" aria-hidden="true" className="size-14 rounded-2xl" />
              <div className="space-y-2">
                <Badge variant="outline">Voice Operations</Badge>
                <div>
                  <CardTitle className="text-2xl tracking-[-0.04em]">VoC Radar</CardTitle>
                  <CardDescription>
                    App Store 리뷰를 운영 신호로 바꾸는 분석 워크스페이스.
                  </CardDescription>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-secondary/55 p-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <Sparkles className="size-4 text-primary" />
                <span className="font-medium">추천 콘셉트 · Signal Desk</span>
              </div>
              <p className="mt-2 text-sm">
                과장된 네온 대신 <span className="text-foreground">차분한 엔터프라이즈 다크 톤</span>, 정제된 모노 숫자,
                미세한 모션으로 신뢰감을 주는 분석 콘솔 스타일입니다.
              </p>
            </div>
          </CardHeader>
        </Card>

        <Card className="lg:flex-1 lg:overflow-hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Compass className="size-4 text-primary" />
              Workspace
            </CardTitle>
            <CardDescription>현재 운영 맥락에 맞는 페이지를 선택하세요.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 lg:overflow-y-auto">
            <nav className="grid gap-2" aria-label="Primary navigation">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'group rounded-2xl border border-transparent px-4 py-3 transition-colors duration-200',
                        isActive
                          ? 'border-primary/25 bg-primary/10 text-foreground'
                          : 'bg-secondary/40 text-muted-foreground hover:border-border/70 hover:bg-accent/55 hover:text-foreground',
                      )
                    }
                  >
                    <div className="flex items-start gap-3">
                      <div className="rounded-xl border border-border/70 bg-background/55 p-2 text-primary">
                        <Icon className="size-4" />
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {item.label}
                          <ArrowRight className="size-3.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                        </div>
                        <p className="text-xs leading-5 text-muted-foreground">{item.description}</p>
                      </div>
                    </div>
                  </NavLink>
                );
              })}
            </nav>

            <Separator />

            <div className="space-y-3">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Selected app</p>
                <p className="mt-2 text-lg font-semibold tracking-[-0.03em] text-foreground">
                  {appName || 'Unknown App'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {selection.appId} · {selection.country.toUpperCase()}
                </p>
              </div>

              <form className="grid gap-3" onSubmit={onApplySelection}>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_104px] lg:grid-cols-1 xl:grid-cols-[minmax(0,1fr)_104px]">
                  <Input
                    value={appIdInput}
                    onChange={(event) => setAppIdInput(event.target.value)}
                    placeholder="App Store ID"
                    aria-label="App Store ID"
                  />
                  <Input
                    value={countryInput}
                    onChange={(event) => setCountryInput(event.target.value)}
                    maxLength={2}
                    placeholder="국가 코드"
                    aria-label="Country code"
                  />
                </div>
                <Button type="submit" variant="outline" className="justify-between">
                  앱 컨텍스트 적용
                  <Activity className="size-4" />
                </Button>
              </form>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Recent apps</p>
                <Badge variant="secondary">{recentApps.length}</Badge>
              </div>
              <div className="grid gap-2">
                {recentApps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">최근 적재된 앱 메타가 아직 없습니다.</p>
                ) : (
                  recentApps.map((app) => {
                    const isSelected = app.app_store_id === selection.appId && app.country === selection.country;
                    return (
                      <button
                        key={`${app.app_store_id}-${app.country}`}
                        type="button"
                        onClick={() =>
                          onSelectionChange({
                            appId: app.app_store_id,
                            country: app.country,
                          })
                        }
                        className={cn(
                          'flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition-colors duration-200',
                          isSelected
                            ? 'border-primary/25 bg-primary/10'
                            : 'border-border/70 bg-background/45 hover:border-border hover:bg-accent/50',
                        )}
                      >
                        <div>
                          <p className="text-sm font-medium text-foreground">{app.app_name || '이름 미확인 앱'}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {app.app_store_id} · {app.country.toUpperCase()}
                          </p>
                        </div>
                        <ArrowRight className="size-4 text-muted-foreground" />
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <Separator />

            <div className="rounded-2xl border border-border/70 bg-background/45 p-4">
              <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Access</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {loggedIn ? '상세 리뷰와 큐 관리 권한이 활성화되어 있습니다.' : '로그인 전에는 공개 리포트만 확인할 수 있습니다.'}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {loggedIn ? (
                  <Button variant="outline" onClick={onSignOut}>
                    <LogOut className="size-4" />
                    로그아웃
                  </Button>
                ) : (
                  <>
                    <Button asChild>
                      <NavLink to="/login">
                        <LogIn className="size-4" />
                        로그인
                      </NavLink>
                    </Button>
                    <Button asChild variant="ghost">
                      <NavLink to="/login?mode=signup">회원가입</NavLink>
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </aside>

      <div className="min-w-0 flex-1 space-y-4">
        <div className="rounded-[1.5rem] border border-border/70 bg-card/70 px-5 py-4 shadow-sm backdrop-blur-xl sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-[0.24em] text-muted-foreground">
                <span>{currentRoute.eyebrow}</span>
                <Badge variant="outline">{activeNav?.label ?? 'Overview'}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{currentRoute.hint}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="kbd-chip">{selection.country.toUpperCase()}</span>
              <span className="kbd-chip font-mono">{selection.appId}</span>
              {loggedIn ? <Badge variant="success">Authenticated</Badge> : <Badge variant="secondary">Public mode</Badge>}
            </div>
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.main
            key={location.pathname}
            initial={reduceMotion ? false : { opacity: 0, y: 16 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: reduceMotion ? 0.01 : 0.28, ease: 'easeOut' }}
            className="pb-8"
          >
            <Outlet />
          </motion.main>
        </AnimatePresence>
      </div>
    </div>
  );
}
