type AuthCallbackLocation = {
  hash: string;
  search: string;
};

const AUTH_RETURN_BASE = 'https://auth-return.invalid';

export function sanitizeAuthReturnTo(returnTo: string | null | undefined) {
  if (!returnTo?.startsWith('/')) {
    return '/requests';
  }

  try {
    const resolved = new URL(returnTo, AUTH_RETURN_BASE);
    if (resolved.origin !== AUTH_RETURN_BASE) {
      return '/requests';
    }

    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/requests';
  }
}

export function buildEmailSignUpCredentials(
  email: string,
  password: string,
  origin: string,
  returnTo = '/requests',
) {
  return {
    email,
    password,
    options: {
      // Keep email confirmation on the deployment that initiated signup, even if the provider fallback is stale.
      emailRedirectTo: new URL(sanitizeAuthReturnTo(returnTo), origin).toString(),
    },
  };
}

export function buildPasswordResetRedirect(
  origin: string,
  returnTo = '/requests',
) {
  const redirect = new URL('/reset-password', origin);
  redirect.searchParams.set('returnTo', sanitizeAuthReturnTo(returnTo));
  return redirect.toString();
}

export function hasSupabaseAuthCallback(location: AuthCallbackLocation) {
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const searchParams = new URLSearchParams(location.search);

  return (
    hashParams.has('access_token') ||
    hashParams.has('refresh_token') ||
    hashParams.has('error') ||
    hashParams.has('error_code') ||
    searchParams.has('code')
  );
}
