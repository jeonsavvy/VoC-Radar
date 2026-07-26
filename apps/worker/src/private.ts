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
  parsePage,
  parsePrivateReviewSortBy,
  parseSortDirection,
  parseRatingFilter,
  normalizePriorityFilter,
  normalizeSearchKeyword,
  normalizeCountry,
  normalizeAppStoreId,
  normalizeOptionalText,
  triggerN8nPipeline,
  isUuid,
  decodeReviewFeedCursor,
  isLegacyTimestampCursor,
  buildReviewFeedFilters,
  normalizeReviewFeedRows,
  UpstreamRequestError,
  boolFromEnv,
} from './platform';

async function handlePrivateCreateJob(env: Env, request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return unauthorized(env, 'missing access token');
  }

  const authorized = await verifyAccessToken(env, authorization);
  if (!authorized) {
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
  const appName = normalizeOptionalText(body?.appName, 120);
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
  if (activeJobs[0]) {
    return jsonResponse(env, 200, { ok: true, result: 'existing', data: activeJobs[0] });
  }

  await supabaseRequest(env, '/rest/v1/apps?on_conflict=app_store_id,country', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([
      {
        app_store_id: appStoreId,
        country,
        app_name: appName,
        updated_at: now,
      },
    ]),
    idempotent: true,
  });

  let data: Array<Record<string, unknown>> = [];
  try {
    data = await supabaseUserRequest<Array<Record<string, unknown>>>(
      env,
      '/rest/v1/pipeline_jobs',
      authorization,
      {
        method: 'POST',
        headers: {
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          app_store_id: appStoreId,
          country,
          app_name: appName,
          note,
          source: 'web',
          status: 'queued',
          stage: 'queued',
          requested_at: now,
          updated_at: now,
        }),
      },
    );
  } catch (error) {
    if (error instanceof UpstreamRequestError && [401, 403].includes(error.status)) {
      return unauthorized(env, 'insufficient access');
    }
    if (error instanceof UpstreamRequestError && error.upstreamCode === '23505') {
      const racedJobs = await supabaseRequest<Array<Record<string, unknown>>>(env, activeJobsPath, {
        method: 'GET',
        idempotent: true,
      });
      if (racedJobs[0]) {
        return jsonResponse(env, 200, { ok: true, result: 'existing', data: racedJobs[0] });
      }
    }
    throw error;
  }

  const created = data[0] || null;
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
  const trigger = await triggerN8nPipeline(env, {
    jobId: String(created.id || '').trim(),
    appStoreId,
    country,
    requestedAt: now,
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
      `/rest/v1/pipeline_jobs?select=id,app_store_id,country,app_name,source,status,stage,run_id,note,requested_at,started_at,finished_at,created_at,updated_at&order=created_at.desc&limit=${limit}`,
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
    data: data.map((row) => ({
      ...row,
      error_message:
        row.status === 'failed'
          ? '분석 요청을 완료하지 못했습니다. 다시 요청해 주세요.'
          : row.status === 'canceled'
            ? '분석 요청이 취소되었습니다.'
            : null,
    })),
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

  let updatedRows: Array<Record<string, unknown>>;
  try {
    updatedRows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/cancel_pipeline_jobs', {
      method: 'POST',
      body: JSON.stringify({
        p_requested_by: user.id,
        p_job_id: null,
        p_cancel_all: true,
        p_app_store_id: null,
        p_country: null,
        p_reason: 'account_deleted',
      }),
      idempotent: true,
    });
  } catch {
    return errorResponse(
      env,
      502,
      'account_delete_not_started',
      '계정 삭제를 완료하지 못했습니다. 계정과 진행 중 요청은 유지됩니다. 다시 시도해 주세요.',
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
      '계정 삭제를 완료하지 못했습니다. 진행 중 요청은 취소되었고 계정은 유지됩니다. 다시 시도해 주세요.',
      true,
    );
  }

  return jsonResponse(env, 200, {
    ok: true,
    data: {
      deleted: true,
      canceledJobs: updatedRows.length,
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

  const { searchParams } = new URL(request.url);
  const appId = normalizeAppStoreId(searchParams.get('appId'));
  const country = normalizeCountry(searchParams.get('country'));
  const limit = clampLimit(searchParams.get('limit'));
  const page = parsePage(searchParams.get('page'));
  const sortBy = parsePrivateReviewSortBy(searchParams.get('sortBy'));
  const sortDirection = parseSortDirection(searchParams.get('sortDirection'));
  const rating = parseRatingFilter(searchParams.get('rating'));
  const priority = normalizePriorityFilter(searchParams.get('priority'));
  const category = normalizeOptionalText(searchParams.get('category'), 120);
  const issueLabel = normalizeOptionalText(searchParams.get('issueLabel'), 120);
  const search = normalizeSearchKeyword(searchParams.get('search'));
  const cursor = searchParams.get('cursor');

  if (!appId) {
    return badRequest(env, 'appId must be numeric');
  }
  if (cursor && isLegacyTimestampCursor(cursor)) {
    return errorResponse(
      env,
      400,
      'legacy_cursor_unsupported',
      '이전 형식의 리뷰 커서는 안전하게 이어갈 수 없습니다. cursor를 제거하고 첫 페이지부터 다시 조회해 주세요.',
    );
  }
  if (cursor && (sortBy !== 'reviewed_at' || !decodeReviewFeedCursor(cursor))) {
    return badRequest(env, 'cursor is invalid for the selected sort');
  }

  const filters = buildReviewFeedFilters({
    appId,
    country,
    limit,
    page,
    sortBy,
    sortDirection,
    rating,
    priority,
    category,
    issueLabel,
    search,
    cursor,
  });

  // private reviews는 Worker에서 access token만 검증하고, 실제 조회는 service_role로 수행한다.
  // 이렇게 하면 view를 authenticated에 직접 노출하지 않아도 된다.
  const data = await supabaseRequest<Array<Record<string, unknown>>>(env, `/rest/v1/private_review_feed?${filters.toString()}`, {
    method: 'GET',
    idempotent: true,
  });

  const normalized = normalizeReviewFeedRows(data, limit, sortBy);
  return jsonResponse(env, 200, {
    data: normalized.data,
    page,
    limit,
    hasNext: normalized.hasNext,
    nextCursor: normalized.nextCursor,
  });
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
