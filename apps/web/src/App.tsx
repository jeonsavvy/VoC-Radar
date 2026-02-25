import { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { signOut } from './lib/auth';
import { supabase } from './lib/supabase';
import { AppOverviewPage } from './routes/AppOverviewPage';
import { CategoriesPage } from './routes/CategoriesPage';
import { HomePage } from './routes/HomePage';
import { LoginPage } from './routes/LoginPage';
import { ReviewsPage } from './routes/ReviewsPage';
import { TrendsPage } from './routes/TrendsPage';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);

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
    refreshSession();

    if (!supabase) {
      return;
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      refreshSession();
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <Shell
              loggedIn={loggedIn}
              onSignOut={() => {
                signOut().finally(() => refreshSession());
              }}
            />
          }
        >
          <Route index element={<HomePage />} />
          <Route path="apps/:appId" element={<AppOverviewPage />} />
          <Route path="trends" element={<TrendsPage />} />
          <Route path="categories" element={<CategoriesPage />} />
          <Route path="login" element={<LoginPage onSignedIn={refreshSession} />} />
          <Route path="reviews" element={<ReviewsPage loggedIn={loggedIn} />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
