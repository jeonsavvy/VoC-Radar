import { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import { defaultSelection, readSelection } from '@/lib/appSelection';
import { signOut } from '@/lib/auth';
import { HomePage } from '@/routes/HomePage';
import { AnalyzePage } from '@/routes/AnalyzePage';
import { LoginPage } from '@/routes/LoginPage';
import { ReviewsPage } from '@/routes/ReviewsPage';
import { supabase } from '@/lib/supabase';

// App.tsx는 Web 앱의 라우팅과 인증 상태를 한곳에서 관리한다.
// 각 페이지는 selection(appId, country)을 공유하며, API 호출은 페이지별로 나눈다.
// 운영 배포 중 새 릴리스가 나가도 route chunk mismatch가 나지 않도록 페이지 코드는 eager import로 유지한다.

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [selection, setSelection] = useState(readSelection);

  // 현재 브라우저 세션에 유효한 Supabase access token이 있는지 확인한다.
  const refreshSession = async () => {
    if (!supabase) {
      setLoggedIn(false);
      setUserEmail(null);
      return;
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const isLoggedIn = Boolean(session?.access_token);
    setLoggedIn(isLoggedIn);
    setUserEmail(isLoggedIn ? session?.user?.email ?? null : null);
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
              userEmail={userEmail}
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
              <HomePage selection={selection} />
            }
          />
          <Route
            path="analyze"
            element={
              <AnalyzePage
                loggedIn={loggedIn}
                selection={selection}
                onSelectionChange={(next) => {
                  setSelection(next || defaultSelection);
                }}
              />
            }
          />
          <Route
            path="login"
            element={
              <LoginPage onSignedIn={refreshSession} />
            }
          />
          <Route
            path="reviews"
            element={
              <ReviewsPage loggedIn={loggedIn} selection={selection} />
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
