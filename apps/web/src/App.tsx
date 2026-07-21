import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import { ExplorePage } from '@/routes/ExplorePage';

const AppReportPage = lazy(() =>
  import('@/routes/AppReportPage').then((module) => ({ default: module.AppReportPage })),
);
const LoginPage = lazy(() => import('@/routes/LoginPage').then((module) => ({ default: module.LoginPage })));
const PrivacyPage = lazy(() => import('@/routes/PrivacyPage').then((module) => ({ default: module.PrivacyPage })));
const RequestsPage = lazy(() => import('@/routes/RequestsPage').then((module) => ({ default: module.RequestsPage })));

function ScrollToTopOnRouteChange() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [pathname]);
  return null;
}

function RouteFallback() {
  return <div className="route-loading" role="status">불러오는 중</div>;
}

function hasStoredAuthSession() {
  try {
    // Supabase sessions are origin-local. Anonymous public readers should not download the auth SDK.
    return Object.keys(window.localStorage).some((key) => key.startsWith('sb-') && key.endsWith('-auth-token'));
  } catch {
    return false;
  }
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const authSubscription = useRef<(() => void) | null>(null);

  const refreshSession = async (isActive: () => boolean = () => true) => {
    const { getSessionSummary, subscribeToAuthChanges } = await import('@/lib/auth');
    const session = await getSessionSummary();
    if (!isActive()) return;
    setLoggedIn(session.loggedIn);
    setUserEmail(session.userEmail);
    if (session.loggedIn && !authSubscription.current) {
      authSubscription.current = subscribeToAuthChanges(() => void refreshSession());
    } else if (!session.loggedIn && authSubscription.current) {
      authSubscription.current();
      authSubscription.current = null;
    }
  };

  useEffect(() => {
    let active = true;
    if (hasStoredAuthSession()) {
      void refreshSession(() => active);
    }

    return () => {
      active = false;
      authSubscription.current?.();
      authSubscription.current = null;
    };
  }, []);

  const handleSignOut = async () => {
    const { signOut } = await import('@/lib/auth');
    await signOut();
    await refreshSession();
  };

  return <BrowserRouter>
    <ScrollToTopOnRouteChange />
    <Routes>
      <Route element={<Shell loggedIn={loggedIn} userEmail={userEmail} onSignOut={handleSignOut} />}>
        <Route index element={<ExplorePage />} />
        <Route path="apps/:country/:appId" element={<Navigate to="overview" replace />} />
        <Route
          path="apps/:country/:appId/:tab"
          element={<Suspense fallback={<RouteFallback />}><AppReportPage loggedIn={loggedIn} /></Suspense>}
        />
        <Route
          path="requests"
          element={<Suspense fallback={<RouteFallback />}><RequestsPage loggedIn={loggedIn} /></Suspense>}
        />
        <Route
          path="login"
          element={<Suspense fallback={<RouteFallback />}><LoginPage onSignedIn={refreshSession} /></Suspense>}
        />
      </Route>
      <Route path="privacy" element={<Suspense fallback={<RouteFallback />}><PrivacyPage /></Suspense>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </BrowserRouter>;
}
