import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Shell } from '@/components/Shell';
import { ExplorePage } from '@/routes/ExplorePage';
import { hasSupabaseAuthCallback, sanitizeAuthReturnTo } from '@/lib/authRedirect';

const AppReportPage = lazy(() =>
  import('@/routes/AppReportPage').then((module) => ({ default: module.AppReportPage })),
);
const LoginPage = lazy(() => import('@/routes/LoginPage').then((module) => ({ default: module.LoginPage })));
const PrivacyPage = lazy(() => import('@/routes/PrivacyPage').then((module) => ({ default: module.PrivacyPage })));
const RequestsPage = lazy(() => import('@/routes/RequestsPage').then((module) => ({ default: module.RequestsPage })));
const ResetPasswordPage = lazy(() =>
  import('@/routes/ResetPasswordPage').then((module) => ({ default: module.ResetPasswordPage })),
);

function SignedInLoginRedirect() {
  const location = useLocation();
  const returnTo = sanitizeAuthReturnTo(new URLSearchParams(location.search).get('returnTo'));
  return <Navigate to={returnTo} replace />;
}

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

type AuthModule = Pick<
  typeof import('@/lib/auth'),
  'getSessionSummary' | 'subscribeToAuthChanges' | 'signOut'
>;
type AppRoutesProps = {
  loadAuthModule?: () => Promise<AuthModule>;
};
type AuthSessionBoundaryProps = AppRoutesProps & {
  children: (state: {
    loggedIn: boolean;
    userEmail: string | null;
    authChecking: boolean;
    refreshSession: (isActive?: () => boolean) => Promise<void>;
    signOut: () => Promise<void>;
  }) => ReactNode;
};

async function defaultLoadAuthModule() {
  return await import('@/lib/auth');
}

export function AuthSessionBoundary({
  loadAuthModule = defaultLoadAuthModule,
  children,
}: AuthSessionBoundaryProps) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authChecking, setAuthChecking] = useState(
    () => hasStoredAuthSession() || hasSupabaseAuthCallback(window.location),
  );
  const authSubscription = useRef<(() => void) | null>(null);

  const refreshSession = async (isActive: () => boolean = () => true) => {
    try {
      const { getSessionSummary, subscribeToAuthChanges } = await loadAuthModule();
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
    } catch {
      if (!isActive()) return;
      setLoggedIn(false);
      setUserEmail(null);
    } finally {
      if (isActive()) setAuthChecking(false);
    }
  };

  useEffect(() => {
    let active = true;
    if (authChecking) {
      void refreshSession(() => active);
    }

    return () => {
      active = false;
      authSubscription.current?.();
      authSubscription.current = null;
    };
  }, []);

  const handleSignOut = async () => {
    const { signOut } = await loadAuthModule();
    await signOut();
    await refreshSession();
  };

  return children({
    loggedIn,
    userEmail,
    authChecking,
    refreshSession,
    signOut: handleSignOut,
  });
}

export function AppRoutes({ loadAuthModule }: AppRoutesProps) {
  return <AuthSessionBoundary loadAuthModule={loadAuthModule}>
    {({ loggedIn, userEmail, authChecking, refreshSession, signOut }) => <>
      <ScrollToTopOnRouteChange />
      <Routes>
        <Route element={<Shell loggedIn={loggedIn} authChecking={authChecking} userEmail={userEmail} onSignOut={signOut} />}>
          <Route index element={<ExplorePage />} />
          <Route path="apps/:country/:appId" element={<Navigate to="overview" replace />} />
          <Route
            path="apps/:country/:appId/:tab"
            element={<Suspense fallback={<RouteFallback />}><AppReportPage loggedIn={loggedIn} authChecking={authChecking} /></Suspense>}
          />
          <Route
            path="requests"
            element={<Suspense fallback={<RouteFallback />}><RequestsPage loggedIn={loggedIn} authChecking={authChecking} /></Suspense>}
          />
          <Route
            path="login"
            element={loggedIn && !authChecking
              ? <SignedInLoginRedirect />
              : <Suspense fallback={<RouteFallback />}><LoginPage onSignedIn={refreshSession} /></Suspense>}
          />
          <Route
            path="reset-password"
            element={<Suspense fallback={<RouteFallback />}><ResetPasswordPage authChecking={authChecking} loggedIn={loggedIn} onSignedOut={refreshSession} /></Suspense>}
          />
        </Route>
        <Route path="privacy" element={<Suspense fallback={<RouteFallback />}><PrivacyPage /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>}
  </AuthSessionBoundary>;
}

export default function App() {
  return <BrowserRouter>
    <AppRoutes />
  </BrowserRouter>;
}
