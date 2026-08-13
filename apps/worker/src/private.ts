import type { CancelPipelineJobsRequest, CreatePipelineJobRequest, Env } from './types';
import {
  jsonResponse,
  errorResponse,
  supabaseRequest,
  supabaseUserRequest,
  deleteSupabaseAuthUser,
  getAuthUser,
  verifyAccessToken,
  badRequest,
  unauthorized,
  clampLimit,
  normalizeCountry,
  normalizeAppStoreId,
  normalizeOptionalText,
  triggerN8nPipeline,
  isUuid,
  UpstreamRequestError,
  boolFromEnv,
  fetchWithRetry,
} from './platform';
import { executeReviewFeed } from './review-feed';

async function resolveVerifiedAppName(
  env: Env,
  appStoreId: string,
  country: string,
): Promise<
  | { status: 'verified'; appName: string }
  | { status: 'not_found' }
  | { status: 'unavailable' }
> {
  try {
    const response = await fetchWithRetry(
      env,
      `https://itunes.apple.com/lookup?id=${encodeURIComponent(appStoreId)}&country=${country.toUpperCase()}&entity=software`,
      {
        upstream: 'apple',
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: 3000,
        retries: 0,
        idempotent: true,
      },
    );
    if (!response.ok) return { status: 'unavailable' };

    const payload = (await response.json()) as {
      results?: Array<{ trackId?: string | number; trackName?: string; wrapperType?: string }>;
    };
    const match = Array.isArray(payload.results)
      ? payload.results.find((item) =>
          item.wrapperType === 'software'
          && normalizeAppStoreId(String(item.trackId || '')) === appStoreId)
      : null;
    const appName = normalizeOptionalText(match?.trackName, 120);
    return appName ? { status: 'verified', appName } : { status: 'not_found' };
  } catch {
    return { status: 'unavailable' };
  }
}

function userJobDailyLimit(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

function jobQuotaExceeded(env: Env) {
  return errorResponse(
    env,
    429,
    'job_daily_limit_reached',
    '최근 24시간 분석 요청 한도에 도달해 새 요청은 대기열에 추가되지 않았습니다. 한도가 갱신된 뒤 다시 요청해 주세요.',
  );
}

async function consumeAppleLookupAttempt(env: Env, userId: string): Promise<Response | null> {
  if (typeof env.APPLE_LOOKUP_RATE_LIMITER?.limit !== 'function') {
    console.error(JSON.stringify({ event: 'apple_lookup_guard_unavailable', path: '/api/private/jobs' }));
    return errorResponse(
      env,
      503,
      'job_request_guard_unavailable',
      '분석 요청 보호 상태를 확인하지 못해 요청을 시작하지 않았습니다. 잠시 후 다시 시도하세요.',
      true,
    );
  }

  try {
    const outcome = await env.APPLE_LOOKUP_RATE_LIMITER.limit({
      key: `private-job-apple-lookup:${userId}`,
    });
    if (outcome.success) return null;
  } catch {
    console.error(JSON.stringify({ event: 'apple_lookup_guard_unavailable', path: '/api/private/jobs' }));
    return errorResponse(
      env,
      503,
      'job_request_guard_unavailable',
      '분석 요청 보호 상태를 확인하지 못해 요청을 시작하지 않았습니다. 잠시 후 다시 시도하세요.',
      true,
    );
  }

  console.warn(JSON.stringify({ event: 'apple_lookup_rate_limited', path: '/api/private/jobs' }));
  return errorResponse(
    env,
    429,
    'job_request_rate_limited',
    '요청이 너무 빠르게 반복되어 분석 요청을 등록하지 않았습니다. 1분 뒤 다시 요청하세요.',
  );
}

function privateJobResponseData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  const appStoreId = typeof source.app_store_id === 'string' ? source.app_store_id.trim() : '';
  const country = typeof source.country === 'string' ? source.country.trim() : '';
  const status = source.status;
  const requestedAt = typeof source.requested_at === 'string' ? source.requested_at : '';
  if (
    !id
    || id.length > 128
    || normalizeAppStoreId(appStoreId) !== appStoreId
    || !/^[a-z]{2}$/.test(country)
    || !['queued', 'running'].includes(String(status || ''))
    || !Number.isFinite(new Date(requestedAt).getTime())
  ) return null;

  const result: Record<string, unknown> = {
    id,
    app_store_id: appStoreId,
    country,
    status,
    requested_at: requestedAt,
  };
  const optionalFields: Array<[string, (candidate: unknown) => boolean]> = [
    ['app_name', (candidate) => candidate === null || typeof candidate === 'string'],
    ['stage', (candidate) => candidate === null || ['queued', 'fetching', 'extracting', 'clustering', 'publishing'].includes(String(candidate))],
    ['run_id', (candidate) => candidate === null || typeof candidate === 'string'],
    ['updated_at', (candidate) => typeof candidate === 'string' && Number.isFinite(new Date(candidate).getTime())],
  ];
  for (const [key, isValid] of optionalFields) {
    if (!Object.hasOwn(source, key)) continue;
    if (!isValid(source[key])) return null;
    result[key] = source[key];
  }
  return result;
}

async function handlePrivateCreateJob(env: Env, request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return unauthorized(env, 'missing access token');
  }

  const user = await getAuthUser(env, authorization);
  if (!user) {
    return unauthorized(env, 'invalid access token');
  }

  let body: CreatePipelineJobRequest;
  try {
    body = (await request.json()) as CreatePipelineJobRequest;
  } catch {
    return badRequest(env, 'invalid json body');
  }

  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  if (!appStoreId) {
    return badRequest(env, 'appStoreId must be numeric');
  }

  const country = normalizeCountry(body?.country);
  const note = normalizeOptionalText(body?.note, 300);
  const now = new Date().toISOString();
  const cooldownUntil = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const freshRuns = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_runs?select=run_id,app_store_id,country,status,published_at,model_version&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}&status=eq.published&published_at=gte.${encodeURIComponent(cooldownUntil)}&order=published_at.desc&limit=1`,
    { method: 'GET', idempotent: true },
  );
  const freshRun = freshRuns[0];
  if (freshRun) {
    const publishedAt = String(freshRun.published_at || now);
    return jsonResponse(env, 200, {
      ok: true,
      result: 'fresh',
      data: {
        runId: freshRun.run_id,
        appStoreId,
        country,
        publishedAt,
        nextAllowedAt: new Date(new Date(publishedAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
  }

  // A refresh can complete without a new published run when the App Store feed has
  // no unseen reviews. Treat that successful check as a cooldown boundary too.
  const completedJobs = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_jobs?select=id,run_id,finished_at&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}&status=eq.completed&finished_at=gte.${encodeURIComponent(cooldownUntil)}&order=finished_at.desc&limit=1`,
    { method: 'GET', idempotent: true },
  );
  const completedJob = completedJobs[0];
  if (completedJob) {
    const latestRuns = await supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/pipeline_runs?select=run_id,published_at&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}&status=eq.published&order=published_at.desc&limit=1`,
      { method: 'GET', idempotent: true },
    );
    const completedAt = String(completedJob.finished_at || now);
    const latestRun = latestRuns[0];
    return jsonResponse(env, 200, {
      ok: true,
      result: 'fresh',
      data: {
        runId: latestRun?.run_id || completedJob.run_id || null,
        appStoreId,
        country,
        publishedAt: latestRun?.published_at || completedAt,
        nextAllowedAt: new Date(new Date(completedAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
  }

  const activeJobsPath = `/rest/v1/pipeline_jobs?select=id,app_store_id,country,app_name,status,stage,run_id,requested_at,updated_at&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}&status=in.(queued,running)&order=requested_at.asc&limit=1`;
  const activeJobs = await supabaseRequest<Array<Record<string, unknown>>>(env, activeJobsPath, {
    method: 'GET',
    idempotent: true,
  });
  const activeJob = privateJobResponseData(activeJobs[0]);
  if (activeJob) {
    return jsonResponse(env, 200, { ok: true, result: 'existing', data: activeJob });
  }

  const dailyLimit = userJobDailyLimit(env.USER_JOB_DAILY_LIMIT);
  try {
    const recentUserJobs = await supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/pipeline_jobs?select=requested_at&requested_by=eq.${encodeURIComponent(user.id)}&source=eq.web&requested_at=gte.${encodeURIComponent(cooldownUntil)}&order=requested_at.asc&limit=${dailyLimit}`,
      { method: 'GET', idempotent: true },
    );
    if (recentUserJobs.length >= dailyLimit) return jobQuotaExceeded(env);
  } catch {
    // The transactional enqueue RPC remains authoritative if this cost-saving
    // preflight cannot be completed.
  }

  const lookupGuardResponse = await consumeAppleLookupAttempt(env, user.id);
  if (lookupGuardResponse) return lookupGuardResponse;

  // The request body is not an authority for a public app identity or name.
  const verification = await resolveVerifiedAppName(env, appStoreId, country);
  if (verification.status === 'not_found') {
    return errorResponse(
      env,
      400,
      'app_not_found',
      'App Store 앱을 확인하지 못했습니다. 앱 링크 또는 숫자 ID를 확인해 다시 요청해 주세요.',
    );
  }
  const appName = verification.status === 'verified' ? verification.appName : null;

  let enqueueResult: { result?: unknown; data?: unknown } = {};
  try {
    enqueueResult = await supabaseRequest<{ result?: unknown; data?: unknown }>(
      env,
      '/rest/v1/rpc/enqueue_pipeline_job',
      {
        method: 'POST',
        body: JSON.stringify({
          p_app_store_id: appStoreId,
          p_country: country,
          p_app_name: appName,
          p_note: note,
          p_requested_by: user.id,
          p_daily_limit: dailyLimit,
        }),
      },
    );
  } catch (error) {
    if (
      error instanceof UpstreamRequestError
      && (
        [401, 403, 404].includes(error.status)
        || ['42501', '42883', 'PGRST202'].includes(error.upstreamCode || '')
      )
    ) {
      return errorResponse(
        env,
        503,
        'job_queue_unavailable',
        '분석 요청을 대기열에 추가하지 못했습니다. 요청은 시작되지 않았습니다. 잠시 후 다시 시도해 주세요.',
        true,
      );
    }
    if (error instanceof UpstreamRequestError && error.upstreamCode === '23505') {
      const racedJobs = await supabaseRequest<Array<Record<string, unknown>>>(env, activeJobsPath, {
        method: 'GET',
        idempotent: true,
      });
      const racedJob = privateJobResponseData(racedJobs[0]);
      if (racedJob) {
        return jsonResponse(env, 200, { ok: true, result: 'existing', data: racedJob });
      }
    }
    throw error;
  }

  if (enqueueResult.result === 'quota_exceeded') {
    return jobQuotaExceeded(env);
  }

  const job = privateJobResponseData(enqueueResult.data);

  if (enqueueResult.result === 'existing' && job) {
    return jsonResponse(env, 200, { ok: true, result: 'existing', data: job });
  }

  const created = enqueueResult.result === 'queued' ? job : null;
  if (!created) {
    return errorResponse(
      env,
      500,
      'job_queue_failed',
      '분석 요청을 대기열에 추가하지 못했습니다. 요청은 시작되지 않았습니다. 잠시 후 다시 시도해 주세요.',
      true,
    );
  }

  // 요청 저장 후 n8n webhook 즉시 호출(실패해도 폴링으로 처리 가능)
  const requestedAt = typeof created.requested_at === 'string' ? created.requested_at : now;
  const trigger = await triggerN8nPipeline(env, {
    jobId: String(created.id || '').trim(),
    appStoreId,
    country,
    requestedAt,
  });

  return jsonResponse(env, 201, {
    ok: true,
    result: 'queued',
    data: created,
    trigger: { dispatched: trigger.dispatched },
  });
}

// -----------------------------------------------------------------------------
// Private API: 로그인 사용자 작업 제어
// -----------------------------------------------------------------------------

async function handlePrivateJobs(env: Env, request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return unauthorized(env, 'missing access token');
  }

  const authorized = await verifyAccessToken(env, authorization);
  if (!authorized) {
    return unauthorized(env, 'invalid access token');
  }

  const { searchParams } = new URL(request.url);
  const limit = clampLimit(searchParams.get('limit'), 20, 50);

  let data: Array<Record<string, unknown>> = [];
  try {
    data = await supabaseUserRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/pipeline_jobs?select=id,app_store_id,country,app_name,source,status,stage,run_id,note,error_message,requested_at,started_at,finished_at,created_at,updated_at&order=created_at.desc&limit=${limit}`,
      authorization,
      {
        method: 'GET',
        idempotent: true,
      },
    );
  } catch (error) {
    if (error instanceof UpstreamRequestError && [401, 403].includes(error.status)) {
      return unauthorized(env, 'insufficient access');
    }
    throw error;
  }

  return jsonResponse(env, 200, {
    data: data.map((row) => {
      const { error_message: storedError, ...safeRow } = row;
      const reviewScopeIncomplete = row.status === 'failed' && storedError === 'review_scope_incomplete';
      return {
        ...safeRow,
        failure_code: reviewScopeIncomplete ? 'review_scope_incomplete' : null,
        error_message:
          reviewScopeIncomplete
            ? '요청 기간의 리뷰가 현재 수집 한도를 초과해 분석을 완료하지 않았습니다.'
            : row.status === 'failed'
              ? '분석 요청을 완료하지 못했습니다. 다시 요청해 주세요.'
              : row.status === 'canceled'
                ? '분석 요청이 취소되었습니다.'
                : null,
      };
    }),
  });
}

async function handlePrivateCancelJobs(env: Env, request: Request) {
  const authorization = request.headers.get('authorization');
  const user = await getAuthUser(env, authorization);
  if (!user) {
    return unauthorized(env, 'invalid access token');
  }

  let body: CancelPipelineJobsRequest;
  try {
    body = (await request.json()) as CancelPipelineJobsRequest;
  } catch {
    return badRequest(env, 'invalid json body');
  }

  const cancelAll = body?.cancelAll === true;
  const jobId = (body?.jobId || '').trim();
  if (!cancelAll && !jobId) {
    return badRequest(env, 'jobId is required when cancelAll is false');
  }

  if (jobId && !isUuid(jobId)) {
    return badRequest(env, 'jobId must be uuid');
  }

  const appStoreId = body?.appStoreId ? normalizeAppStoreId(body.appStoreId) : null;
  const country = body?.country ? normalizeCountry(body.country) : null;

  const updatedRows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/cancel_pipeline_jobs', {
    method: 'POST',
    body: JSON.stringify({
      p_requested_by: user.id,
      p_job_id: jobId || null,
      p_cancel_all: cancelAll,
      p_app_store_id: cancelAll ? appStoreId : null,
      p_country: cancelAll ? country : null,
      p_reason: 'user_canceled',
    }),
    idempotent: true,
  });

  return jsonResponse(env, 200, {
    ok: true,
    canceledCount: updatedRows.length,
    data: updatedRows,
  });
}

async function handlePrivateDeleteAccount(env: Env, request: Request) {
  const authorization = request.headers.get('authorization');
  const user = await getAuthUser(env, authorization);
  if (!user) {
    return unauthorized(env, 'invalid access token');
  }

  let canceledJobs = 0;
  let redactedJobs = 0;
  try {
    const preparedRows = await supabaseRequest<Array<Record<string, unknown>>>(
      env,
      '/rest/v1/rpc/prepare_account_deletion',
      {
      method: 'POST',
      body: JSON.stringify({ p_requested_by: user.id }),
      idempotent: true,
      },
    );
    const prepared = preparedRows.length === 1 ? preparedRows[0] : null;
    canceledJobs = Number(prepared?.canceled_jobs);
    redactedJobs = Number(prepared?.redacted_jobs);
    if (
      !Number.isSafeInteger(canceledJobs)
      || canceledJobs < 0
      || !Number.isSafeInteger(redactedJobs)
      || redactedJobs < 0
    ) {
      throw new Error('invalid account deletion preparation response');
    }
  } catch {
    return errorResponse(
      env,
      502,
      'account_delete_not_started',
      '계정 삭제를 완료하지 못했습니다. 계정은 유지되지만 요청 취소와 메모 삭제 여부를 확인하지 못했습니다. 다시 시도해 주세요.',
      true,
    );
  }

  try {
    await deleteSupabaseAuthUser(env, user.id);
  } catch {
    return errorResponse(
      env,
      502,
      'account_delete_incomplete',
      '요청 취소와 메모 삭제는 완료했지만 계정 삭제 결과는 확인하지 못했습니다. 새로고침해 로그인 상태를 확인하고, 계정이 남아 있으면 다시 시도해 주세요.',
      true,
    );
  }

  return jsonResponse(env, 200, {
    ok: true,
    data: {
      deleted: true,
      canceledJobs,
      redactedJobs,
    },
  });
}

async function handlePrivateReviews(env: Env, request: Request) {
  if (!boolFromEnv(env.DETAIL_VIEW_ENABLED, true)) {
    return errorResponse(env, 403, 'detail_view_disabled', '리뷰 상세 조회 기능은 현재 사용할 수 없습니다.');
  }

  const authorization = request.headers.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return unauthorized(env, 'missing access token');
  }

  const authorized = await verifyAccessToken(env, authorization);
  if (!authorized) {
    return unauthorized(env, 'invalid access token');
  }

  // private reviews는 Worker에서 access token만 검증하고, 실제 조회는 service_role로 수행한다.
  // 이렇게 하면 view를 authenticated에 직접 노출하지 않아도 된다.
  return executeReviewFeed(env, request, 'private');
}


/** Returns null when the request is not a private API route. */
export async function routePrivateRequest(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/private/jobs') return handlePrivateJobs(env, request);
  if (request.method === 'DELETE' && url.pathname === '/api/private/account') return handlePrivateDeleteAccount(env, request);
  if (request.method === 'POST' && url.pathname === '/api/private/jobs/cancel') return handlePrivateCancelJobs(env, request);
  if (request.method === 'POST' && url.pathname === '/api/private/jobs') return handlePrivateCreateJob(env, request);
  if (request.method === 'GET' && url.pathname === '/api/private/reviews') return handlePrivateReviews(env, request);
  return null;
}
