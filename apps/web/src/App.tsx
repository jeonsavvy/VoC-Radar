import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import { signOut } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { AppReportPage } from '@/routes/AppReportPage';
import { ExplorePage } from '@/routes/ExplorePage';
import { LoginPage } from '@/routes/LoginPage';
import { PrivacyPage } from '@/routes/PrivacyPage';
import { RequestsPage } from '@/routes/RequestsPage';

function ScrollToTopOnRouteChange() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [pathname]);
  return null;
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const refreshSession = async () => {
    if (!supabase) { setLoggedIn(false); setUserEmail(null); return; }
    const { data: { session } } = await supabase.auth.getSession();
    setLoggedIn(Boolean(session?.access_token));
    setUserEmail(session?.user?.email || null);
  };

  useEffect(() => {
    void refreshSession();
    if (!supabase) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => void refreshSession());
    return () => subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => { await signOut(); await refreshSession(); };

  return <BrowserRouter>
    <ScrollToTopOnRouteChange />
    <Routes>
      <Route element={<Shell loggedIn={loggedIn} userEmail={userEmail} onSignOut={handleSignOut} />}>
        <Route index element={<ExplorePage />} />
        <Route path="apps/:country/:appId" element={<Navigate to="issues" replace />} />
        <Route path="apps/:country/:appId/:tab" element={<AppReportPage loggedIn={loggedIn} />} />
        <Route path="requests" element={<RequestsPage loggedIn={loggedIn} />} />
        <Route path="login" element={<LoginPage onSignedIn={refreshSession} />} />
      </Route>
      <Route path="privacy" element={<PrivacyPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </BrowserRouter>;
}
