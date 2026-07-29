import { ApiError } from '@/lib/api';

export const ANALYSIS_REQUEST_SESSION_MESSAGE =
  '로그인 세션을 확인하지 못해 분석 요청을 등록하지 않았습니다. 다시 로그인한 뒤 요청하세요.';

export function isSessionRejected(error: unknown) {
  return error instanceof ApiError
    && error.status === 401
    && error.code === 'unauthorized'
    && !error.retryable;
}

export function getAnalysisRequestFailureMessage(error: unknown, fallback: string) {
  if (isSessionRejected(error)) {
    return ANALYSIS_REQUEST_SESSION_MESSAGE;
  }

  if (
    error instanceof ApiError
    && error.status === 503
    && error.code === 'job_request_guard_unavailable'
  ) {
    return error.message;
  }

  const isSafeRequestRejection = error instanceof ApiError
    && !error.retryable
    && (
      (error.status === 429 && error.code === 'job_daily_limit_reached')
      || (error.status === 429 && error.code === 'job_request_rate_limited')
      || (error.status === 400 && error.code === 'app_not_found')
    );

  if (
    isSafeRequestRejection
  ) {
    return error.message;
  }

  return fallback;
}
