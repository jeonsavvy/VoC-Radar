import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { defaultSelection, persistSelection, readSelection } from './lib/appSelection';
import { signOut } from './lib/auth';
import { supabase } from './lib/supabase';
import { AnalyzePage } from './routes/AnalyzePage';
import { HomePage } from './routes/HomePage';
import { LoginPage } from './routes/LoginPage';
import { ReviewsPage } from './routes/ReviewsPage';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [selection, setSelection] = useState(readSelection);

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

  useEffect(() => {
    persistSelection(selection);
  }, [selection]);

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
                signOut().finally(() => refreshSession());
              }}
            />
          }
        >
          <Route index element={<HomePage selection={selection} />} />
          <Route path="apps/:appId?" element={<Navigate to="/" replace />} />
          <Route path="categories" element={<Navigate to="/" replace />} />
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
          <Route path="login" element={<LoginPage onSignedIn={refreshSession} />} />
          <Route path="reviews" element={<ReviewsPage loggedIn={loggedIn} selection={selection} />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
