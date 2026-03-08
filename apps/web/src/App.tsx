import { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import { defaultSelection, readSelection } from '@/lib/appSelection';
import { signOut } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

// App.tsx는 Web 앱의 라우팅과 인증 상태를 한곳에서 관리한다.
// 각 페이지는 selection(appId, country)을 공유하며, API 호출은 페이지별로 나눈다.
const HomePage = lazy(() => import('@/routes/HomePage').then((module) => ({ default: module.HomePage })));
const AnalyzePage = lazy(() => import('@/routes/AnalyzePage').then((module) => ({ default: module.AnalyzePage })));
const LoginPage = lazy(() => import('@/routes/LoginPage').then((module) => ({ default: module.LoginPage })));
const ReviewsPage = lazy(() => import('@/routes/ReviewsPage').then((module) => ({ default: module.ReviewsPage })));

function RouteFallback() {
  return (
    <div className="rounded-[1rem] border border-border bg-card p-6 text-sm text-muted-foreground shadow-sm">
      화면을 준비하는 중입니다...
    </div>
  );
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [selection, setSelection] = useState(readSelection);

  // 현재 브라우저 세션에 유효한 Supabase access token이 있는지 확인한다.
  const refreshSession = async () => {
    if (!supabase) {
      setLoggedIn(false);
      return;
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    setLoggedIn(Boolean(session?.access_token));
  };

  useEffect(() => {
    void refreshSession();

    if (!supabase) {
      return;
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void refreshSession();
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <Shell
              loggedIn={loggedIn}
              selection={selection}
              onSelectionChange={setSelection}
              onSignOut={() => {
                signOut().finally(() => {
                  void refreshSession();
                });
              }}
            />
          }
        >
          <Route
            index
            element={
              <Suspense fallback={<RouteFallback />}>
                <HomePage selection={selection} />
              </Suspense>
            }
          />
          <Route
            path="analyze"
            element={
              <Suspense fallback={<RouteFallback />}>
                <AnalyzePage
                  loggedIn={loggedIn}
                  selection={selection}
                  onSelectionChange={(next) => {
                    setSelection(next || defaultSelection);
                  }}
                />
              </Suspense>
            }
          />
          <Route
            path="login"
            element={
              <Suspense fallback={<RouteFallback />}>
                <LoginPage onSignedIn={refreshSession} />
              </Suspense>
            }
          />
          <Route
            path="reviews"
            element={
              <Suspense fallback={<RouteFallback />}>
                <ReviewsPage loggedIn={loggedIn} selection={selection} />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
