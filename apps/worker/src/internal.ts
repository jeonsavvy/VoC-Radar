import type {
  AlertEventsRequest, ClaimJobRequest, ClusterContextRequest, Env, FetchReviewsRequest, FilterNewReviewsRequest, JobStatusRequest, ParseErrorRequest, PipelineHeartbeatRequest, PublishRequest, UpsertClustersRequest, UpsertReviewRequest,
} from './types';
import { validateClusterContract } from './cluster-contract';
import {
  jsonResponse,
  errorResponse,
  fetchWithRetry,
  supabaseRequest,
  badRequest,
  unauthorized,
  verifySignedRequest,
  setCacheVersion,
  clampLimit,
  normalizeCountry,
  normalizeAppStoreId,
  normalizeOptionalText,
  normalizeVocCategory,
  normalizeIssueLabel,
  normalizeReasonSummary,
  normalizeActionHint,
  derivePriorityValue,
  isUuid,
  normalizePipelineClaim,
  jobClaimLost,
  renewPipelineJobClaim,
  completePipelineJob,
  normalizeReviewedAt,
  normalizeRating,
  UpstreamRequestError,
  NormalizedReview,
  type PipelineClaim,
  type PipelineStage,
  type RequestInitWithRetry,
  DEFAULT_FETCH_WINDOW_DAYS,
  MAX_FETCH_WINDOW_DAYS,
  MAX_FETCH_MAX_PAGES,
  DEFAULT_FETCH_MAX_PAGES,
  MAX_FETCH_REVIEW_CAP,
  ITUNES_USER_REVIEW_PAGE_SIZE,
  PIPELINE_DB_TIMEOUT_MS,
} from './platform';

type ReviewLookupResult<T> =
  | { status: 'ok'; rows: T[] }
  | { status: 'claim_lost'; rows: [] }
  | { status: 'invalid'; rows: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const APPLE_RSS_REVIEW_PAGE_SIZE = 50;
const APPLE_REVIEW_PAGE_TIMEOUT_MS = 5_000;
const FETCH_REVIEWS_DEADLINE_MS = 270_000;

const pipelineSupabaseRequest = <T>(
  env: Env,
  path: string,
  init: RequestInitWithRetry,
) => supabaseRequest<T>(env, path, {
  timeoutMs: PIPELINE_DB_TIMEOUT_MS,
  ...init,
  retries: 0,
});

function unwrapJsonbArray<T extends Record<string, unknown>>(
  payload: unknown,
  functionName: string,
): T[] | null {
  const unwrapRows = (value: unknown) =>
    Array.isArray(value) && value.every(isRecord) ? value as T[] : null;
  if (Array.isArray(payload)) {
    if (
      payload.length === 1
      && isRecord(payload[0])
      && Object.hasOwn(payload[0], functionName)
    ) {
      return unwrapRows(payload[0][functionName]);
    }
    return unwrapRows(payload);
  }
  if (isRecord(payload) && Object.hasOwn(payload, functionName)) {
    return unwrapRows(payload[functionName]);
  }
  return null;
}

const unwrapPipelineReviewScope = <T extends Record<string, unknown>>(payload: unknown) =>
  unwrapJsonbArray<T>(payload, 'get_pipeline_review_scope');

async function fetchScopedReviewRows<T extends Record<string, unknown>>(
  env: Env,
  claim: PipelineClaim,
  reviewIds: string[],
  heartbeatStage: PipelineStage | null,
  expectedScope: { appStoreId: string; country: string },
  includeAnalysis: boolean,
): Promise<ReviewLookupResult<T>> {
  if (
    reviewIds.length === 0
    || reviewIds.length > MAX_FETCH_REVIEW_CAP
    || new Set(reviewIds).size !== reviewIds.length
  ) {
    return { status: 'invalid', rows: [] };
  }

  const beforeLookup = await renewPipelineJobClaim(env, claim, heartbeatStage);
  if (beforeLookup?.status !== 'running') return { status: 'claim_lost', rows: [] };
  const payload = await pipelineSupabaseRequest<unknown>(env, '/rest/v1/rpc/get_pipeline_review_scope', {
    method: 'POST',
    body: JSON.stringify({
      p_app_store_id: expectedScope.appStoreId,
      p_country: expectedScope.country,
      p_review_ids: reviewIds,
      p_include_analysis: includeAnalysis,
    }),
    idempotent: true,
  });
  const afterLookup = await renewPipelineJobClaim(env, claim, heartbeatStage);
  if (afterLookup?.status !== 'running') return { status: 'claim_lost', rows: [] };
  const rows = unwrapPipelineReviewScope<T>(payload);
  if (!rows) return { status: 'invalid', rows: [] };

  const requestedIds = new Set(reviewIds);
  const rowsById = new Map<string, T>();
  for (const row of rows) {
    const reviewId = String(row.review_id || '').trim();
    const appStoreId = String(row.app_store_id || '').trim();
    const country = String(row.country || '').trim().toLowerCase();
    if (
      !requestedIds.has(reviewId)
      || rowsById.has(reviewId)
      || appStoreId !== expectedScope.appStoreId
      || country !== expectedScope.country
    ) {
      return { status: 'invalid', rows: [] };
    }
    rowsById.set(reviewId, row);
  }

  return {
    status: 'ok',
    rows: reviewIds.flatMap((reviewId) => {
      const row = rowsById.get(reviewId);
      return row ? [row] : [];
    }),
  };
}

async function handleInternalFetchReviews(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: FetchReviewsRequest;
  try {
    body = JSON.parse(rawBody) as FetchReviewsRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const claim = normalizePipelineClaim(body);
  if (!claim) return badRequest(env, 'jobId, claimToken, and runId are required');
  const deadlineAt = Date.now() + FETCH_REVIEWS_DEADLINE_MS;
  const remainingBudget = (requiredMs = 1) => {
    const remainingMs = Math.floor(deadlineAt - Date.now());
    if (remainingMs < requiredMs) {
      throw new UpstreamRequestError('apple', 504, 'review_fetch_deadline_exceeded');
    }
    return remainingMs;
  };
  const applePageTimeout = () => Math.min(
    APPLE_REVIEW_PAGE_TIMEOUT_MS,
    remainingBudget(),
  );
  const renewFetchClaim = async () => {
    remainingBudget(PIPELINE_DB_TIMEOUT_MS + 1);
    const heartbeat = await renewPipelineJobClaim(env, claim, 'fetching');
    if (heartbeat?.status !== 'running') return null;
    return heartbeat;
  };
  const activeClaim = await renewPipelineJobClaim(env, claim, 'fetching');
  if (activeClaim?.status !== 'running') return jobClaimLost(env);

  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  if (!appStoreId) {
    return badRequest(env, 'appStoreId must be numeric');
  }

  const country = normalizeCountry(body?.country);
  const windowDays = clampLimit(
    String(body?.windowDays ?? DEFAULT_FETCH_WINDOW_DAYS),
    DEFAULT_FETCH_WINDOW_DAYS,
    MAX_FETCH_WINDOW_DAYS,
  );
  const maxPages = clampLimit(
    String(body?.maxPages ?? DEFAULT_FETCH_MAX_PAGES),
    DEFAULT_FETCH_MAX_PAGES,
    MAX_FETCH_MAX_PAGES,
  );
  const limitCap = clampLimit(String(body?.limit ?? MAX_FETCH_REVIEW_CAP), MAX_FETCH_REVIEW_CAP, MAX_FETCH_REVIEW_CAP);
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const reviews: NormalizedReview[] = [];
  const seenIds = new Set<string>();
  let pagesFetched = 0;
  let truncated = false;
  let collectionComplete = false;
  let terminationReason = '';
  let rssFirstPageFailed = false;

  const failIncompletePage = (): never => {
    throw new UpstreamRequestError('apple', 503, 'review_page_incomplete');
  };

  for (let page = 1; page <= maxPages + 1 && reviews.length < limitCap; page += 1) {
    const isProbePage = page > maxPages;
    if (!isProbePage && page > 1 && page % 10 === 1) {
      const heartbeat = await renewFetchClaim();
      if (!heartbeat) return jobClaimLost(env);
    }
    // Apple RSS currently returns the standard 50-review page without a limit segment.
    // Keeping /limit=50/ in this path can yield an incomplete feed or a 403 from edge networks.
    const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appStoreId}/sortby=mostrecent/json`;
    const response = await fetchWithRetry(env, url, {
      upstream: 'apple',
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'VoC-Radar/0.2',
      },
      timeoutMs: applePageTimeout(),
      retries: 0,
      idempotent: true,
      redirect: 'manual',
    });

    if (!response.ok) {
      if (page === 1) {
        rssFirstPageFailed = true;
        break;
      }
      failIncompletePage();
    }

    if (!isProbePage) pagesFetched += 1;

    let payload: Record<string, unknown> = {};
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      if (page === 1) {
        rssFirstPageFailed = true;
        break;
      }
      failIncompletePage();
    }

    const feed = payload.feed as Record<string, unknown> | undefined;
    const entries = Array.isArray(feed?.entry) ? (feed.entry as Array<Record<string, unknown>>) : [];
    if (entries.length === 0) {
      collectionComplete = true;
      terminationReason = 'empty_page';
      break;
    }

    let addedInPage = 0;
    let reachedOlderReviews = false;
    let invalidEntry = false;
    let probeHasMore = false;
    for (const entry of entries) {
      const reviewId = String((entry.id as { label?: string } | undefined)?.label ?? entry.id ?? '').trim();
      const rating = normalizeRating((entry['im:rating'] as { label?: string } | undefined)?.label ?? entry['im:rating']);
      const rawReviewedAt = (entry.updated as { label?: string } | undefined)?.label ?? entry.updated;
      const reviewedAtMs = new Date(String(rawReviewedAt || '')).getTime();
      const reviewedAt = Number.isFinite(reviewedAtMs) ? new Date(reviewedAtMs).toISOString() : '';

      if (!reviewId || rating <= 0 || !Number.isFinite(reviewedAtMs) || seenIds.has(reviewId)) {
        invalidEntry = true;
        continue;
      }
      if (reviewedAtMs < cutoff) {
        reachedOlderReviews = true;
        continue;
      }

      if (isProbePage) {
        probeHasMore = true;
        continue;
      }

      seenIds.add(reviewId);
      addedInPage += 1;

      reviews.push({
        reviewId,
        author: String(
          ((entry.author as { name?: { label?: string } } | undefined)?.name?.label ??
            (entry.author as { name?: string } | undefined)?.name ??
            'unknown'),
        ).trim(),
        content: String(
          ((entry.content as { label?: string; '#text'?: string } | undefined)?.label ??
            (entry.content as { '#text'?: string } | undefined)?.['#text'] ??
            entry.content ??
            ''),
        ).trim(),
        rating,
        reviewedAt,
      });

      if (reviews.length >= limitCap) {
        truncated = true;
        terminationReason = 'review_cap';
        break;
      }
    }

    if (invalidEntry) failIncompletePage();
    if (isProbePage) {
      if (probeHasMore) {
        truncated = true;
        terminationReason = 'max_pages';
      } else if (reachedOlderReviews) {
        collectionComplete = true;
        terminationReason = 'window_cutoff';
      } else {
        failIncompletePage();
      }
      break;
    }
    if (truncated) break;
    if (reachedOlderReviews) {
      collectionComplete = true;
      terminationReason = 'window_cutoff';
      break;
    }
    if (addedInPage === 0) {
      failIncompletePage();
    }
    if (entries.length < APPLE_RSS_REVIEW_PAGE_SIZE) {
      collectionComplete = true;
      terminationReason = 'short_page';
      break;
    }
  }

  // Some apps or Apple edge locations return an empty/blocked RSS feed.
  // The storefront review-row endpoint is the current fallback for the KR storefront.
  if (
    reviews.length === 0
    && country === 'kr'
    && (rssFirstPageFailed || terminationReason === 'empty_page')
  ) {
    collectionComplete = false;
    terminationReason = '';
    for (let page = 0; page <= maxPages && reviews.length < limitCap; page += 1) {
      const isProbePage = page >= maxPages;
      if (!isProbePage && page > 0 && page % 10 === 0) {
        const heartbeat = await renewFetchClaim();
        if (!heartbeat) return jobClaimLost(env);
      }
      const startIndex = page * ITUNES_USER_REVIEW_PAGE_SIZE;
      const endIndex = startIndex + ITUNES_USER_REVIEW_PAGE_SIZE - 1;
      const url =
        'https://itunes.apple.com/WebObjects/MZStore.woa/wa/userReviewsRow' +
        `?cc=${country}&id=${appStoreId}&displayable-kind=11&startIndex=${startIndex}&endIndex=${endIndex}&sort=4`;
      const response = await fetchWithRetry(env, url, {
        upstream: 'apple',
        method: 'GET',
        headers: {
          accept: 'application/json',
          referer: `https://apps.apple.com/${country}/app/id${appStoreId}`,
          'user-agent':
            'iTunes/12.12.10 (Windows; Microsoft Windows 10 x64 Business Edition (Build 19045); x64) AppleWebKit/7613.300.10.1',
          'x-apple-store-front': '143466-13,29',
        },
        timeoutMs: applePageTimeout(),
        retries: 0,
        idempotent: true,
        redirect: 'manual',
      });

      if (!response.ok) {
        failIncompletePage();
      }

      let payload: { userReviewList?: Array<Record<string, unknown>> } = {};
      try {
        payload = (await response.json()) as { userReviewList?: Array<Record<string, unknown>> };
      } catch {
        failIncompletePage();
      }
      const entries = Array.isArray(payload.userReviewList) ? payload.userReviewList : [];
      if (entries.length === 0) {
        collectionComplete = true;
        terminationReason = 'empty_page';
        break;
      }

      if (!isProbePage) pagesFetched += 1;
      let addedInPage = 0;
      let reachedOlderReviews = false;
      let invalidEntry = false;
      let probeHasMore = false;
      for (const entry of entries) {
        const reviewId = String(entry.userReviewId || '').trim();
        const rating = normalizeRating(entry.rating);
        const rawReviewedAt = entry.date;
        const reviewedAtMs = new Date(String(rawReviewedAt || '')).getTime();
        const reviewedAt = Number.isFinite(reviewedAtMs) ? new Date(reviewedAtMs).toISOString() : '';

        if (!reviewId || rating <= 0 || !Number.isFinite(reviewedAtMs) || seenIds.has(reviewId)) {
          invalidEntry = true;
          continue;
        }
        if (reviewedAtMs < cutoff) {
          reachedOlderReviews = true;
          continue;
        }

        if (isProbePage) {
          probeHasMore = true;
          continue;
        }

        seenIds.add(reviewId);
        addedInPage += 1;
        reviews.push({
          reviewId,
          author: String(entry.name || 'unknown').trim(),
          content: String(entry.body || '').trim(),
          rating,
          reviewedAt,
        });

        if (reviews.length >= limitCap) {
          truncated = true;
          terminationReason = 'review_cap';
          break;
        }
      }

      if (invalidEntry) failIncompletePage();
      if (isProbePage) {
        if (probeHasMore) {
          truncated = true;
          terminationReason = 'max_pages';
        } else if (reachedOlderReviews) {
          collectionComplete = true;
          terminationReason = 'window_cutoff';
        } else {
          failIncompletePage();
        }
        break;
      }
      if (truncated) break;
      if (reachedOlderReviews) {
        collectionComplete = true;
        terminationReason = 'window_cutoff';
        break;
      }
      if (addedInPage === 0) failIncompletePage();
      if (entries.length < ITUNES_USER_REVIEW_PAGE_SIZE) {
        collectionComplete = true;
        terminationReason = 'short_page';
        break;
      }
    }
  }

  if (rssFirstPageFailed && country !== 'kr') failIncompletePage();
  if (!collectionComplete && !truncated) failIncompletePage();

  if (truncated) {
    remainingBudget(PIPELINE_DB_TIMEOUT_MS + 1);
    const completion = await completePipelineJob(env, {
      ...claim,
      status: 'failed',
      errorMessage: 'review_scope_incomplete',
    });
    if (!completion.updated) return jobClaimLost(env);
    return errorResponse(
      env,
      422,
      'review_scope_incomplete',
      '요청 기간의 리뷰가 현재 수집 한도를 초과했습니다. 부분 데이터는 게시하지 않았으며 기존 공개 리포트는 변경되지 않았습니다. 수집 범위가 확장되기 전에는 같은 조건으로 재시도하지 마세요.',
    );
  }

  return jsonResponse(env, 200, {
    ok: true,
    data: {
      appStoreId,
      country,
      windowDays,
      maxPages,
      limitCap,
      pagesFetched,
      reviews,
      totalFetched: reviews.length,
      complete: true,
      truncated: false,
      terminationReason,
    },
  });
}
async function handleInternalFilterNewReviews(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: FilterNewReviewsRequest;
  try {
    body = JSON.parse(rawBody) as FilterNewReviewsRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  if (!appStoreId) {
    return badRequest(env, 'appStoreId must be numeric');
  }

  const country = normalizeCountry(body?.country);
  const jobId = (body?.jobId || '').toString().trim();
  const claim = normalizePipelineClaim(body);
  if (!claim) return badRequest(env, 'jobId, claimToken, and runId are required');
  const runId = claim.runId;
  const forceReanalysis = body?.forceReanalysis === true;

  const guardedJob = await renewPipelineJobClaim(env, claim, 'extracting');
  if (!guardedJob) return jobClaimLost(env);
  if (guardedJob.status === 'completed') {
    return jsonResponse(env, 200, {
      ok: true,
      data: { total: 0, existingCount: 0, newCount: 0, reviews: [], autoCompleted: true, forceReanalysis },
    });
  }
  if (guardedJob.status !== 'running') return jobClaimLost(env);

  const completeJobIfNoNewReviews = async () => completePipelineJob(env, {
    ...claim,
    status: 'completed',
  });
  const failUnknownReviewIds = async () => {
    const completion = await completePipelineJob(env, {
      ...claim,
      status: 'failed',
      errorMessage: 'The requested review scope was unavailable. Retry the request.',
    });
    if (!completion.updated) return jobClaimLost(env);
    return errorResponse(
      env,
      422,
      'unknown_review_ids',
      '입력 리뷰를 확인하지 못했습니다. 작업은 실패 상태이며 다시 요청할 수 있습니다.',
    );
  };

  const inputReviews = Array.isArray(body?.reviews) ? body.reviews : [];
  if (inputReviews.length === 0) {
    const completion = await completeJobIfNoNewReviews();
    if (!completion.updated) return jobClaimLost(env);
    return jsonResponse(env, 200, {
      ok: true,
      data: { total: 0, existingCount: 0, newCount: 0, reviews: [], autoCompleted: isUuid(jobId) },
    });
  }

  const seen = new Set<string>();
  const normalizedReviews = inputReviews
    .map((review) => ({
      reviewId: String(review.reviewId || '').trim(),
      author: String(review.author || '').trim() || 'unknown',
      content: String(review.content || '').trim(),
      rating: normalizeRating(review.rating),
      reviewedAt: normalizeReviewedAt(review.reviewedAt),
    }))
    .filter((review) => {
      if (!review.reviewId || review.rating <= 0) {
        return false;
      }
      if (seen.has(review.reviewId)) {
        return false;
      }
      seen.add(review.reviewId);
      return true;
    });

  if (normalizedReviews.length === 0) {
    const completion = await completeJobIfNoNewReviews();
    if (!completion.updated) return jobClaimLost(env);
    return jsonResponse(env, 200, {
      ok: true,
      data: { total: 0, existingCount: 0, newCount: 0, reviews: [], autoCompleted: isUuid(jobId) },
    });
  }

  // The scalar JSONB RPC avoids PostgREST's set-returning row cap while keeping
  // all committed-review scope checks behind the service-role boundary.
  const lookup = await fetchScopedReviewRows<Record<string, unknown>>(
    env,
    claim,
    normalizedReviews.map((review) => review.reviewId),
    'extracting',
    { appStoreId, country },
    true,
  );
  if (lookup.status === 'claim_lost') return jobClaimLost(env);
  if (lookup.status === 'invalid') return failUnknownReviewIds();

  const existingRows = lookup.rows;
  const existingIds = new Set(existingRows.map((row) => String(row.review_id || '')));
  const freshReviews = normalizedReviews.filter((review) => !existingIds.has(review.reviewId));
  const incomingReviewsById = new Map(normalizedReviews.map((review) => [review.reviewId, review]));
  let existingExtractions: Array<Record<string, unknown>> = [];
  if (forceReanalysis && existingIds.size > 0) {
    existingExtractions = existingRows.map((row) => {
      const incoming = incomingReviewsById.get(String(row.review_id || ''))!;
      return {
        ID: row.review_id,
        id: row.review_id,
        rating: incoming.rating,
        author: incoming.author,
        content: incoming.content,
        date: incoming.reviewedAt,
        priority: row.priority,
        category: row.category,
        summary: row.summary,
        appStoreId,
        country,
        runId,
        jobId: jobId || null,
        isExisting: true,
      };
    });
  }

  if (freshReviews.length === 0 && !forceReanalysis) {
    const completion = await completeJobIfNoNewReviews();
    if (!completion.updated) return jobClaimLost(env);
  }

  return jsonResponse(env, 200, {
    ok: true,
    data: {
      total: normalizedReviews.length,
      existingCount: existingIds.size,
      newCount: freshReviews.length,
      reviews: freshReviews,
      existingExtractions,
      autoCompleted: freshReviews.length === 0 && !forceReanalysis && isUuid(jobId),
      forceReanalysis,
    },
  });
}

// -----------------------------------------------------------------------------
// Internal API: n8n 파이프라인 전용
// -----------------------------------------------------------------------------

async function handleInternalClaimJob(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: Partial<ClaimJobRequest> = {};
  try {
    body = rawBody ? (JSON.parse(rawBody) as Partial<ClaimJobRequest>) : {};
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const claimKey = normalizeOptionalText(body.claimKey, 200);
  const idempotencyKey = normalizeOptionalText(request.headers.get('x-idempotency-key'), 200);
  if (!claimKey || !idempotencyKey || claimKey !== idempotencyKey) {
    return badRequest(env, 'claimKey must match x-idempotency-key');
  }

  const allowFallback = body.allowFallback === true;
  const fallbackAppStoreId = allowFallback ? normalizeAppStoreId(body.fallbackAppStoreId) : null;
  const fallbackCountry = allowFallback ? normalizeCountry(body.fallbackCountry) : null;
  const fallbackAppName = allowFallback ? normalizeOptionalText(body.fallbackAppName, 120) : null;

  const rows = await pipelineSupabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/claim_pipeline_job', {
    method: 'POST',
    body: JSON.stringify({
      p_claim_key: claimKey,
      p_default_app_store_id: fallbackAppStoreId,
      p_default_country: fallbackCountry,
      p_default_app_name: fallbackAppName,
    }),
    idempotent: false,
  });

  const row = rows[0] || {};
  const status = ((row.status as string | null) || 'empty').toLowerCase();
  const jobId = (row.job_id as string | null) || null;
  const claimToken = (row.claim_token as string | null) || null;
  const isFallback = status === 'fallback';
  const data = {
    jobId,
    claimToken,
    noJob: jobId == null && !isFallback,
    appStoreId: (row.app_store_id as string | null) || (isFallback ? fallbackAppStoreId : null),
    country:
      (row.country as string | null) ||
      (isFallback && fallbackCountry ? normalizeCountry(fallbackCountry) : null),
    appName: (row.app_name as string | null) || (isFallback ? fallbackAppName : null),
    source: (row.source as string | null) || 'queue',
    status,
    requestedAt: (row.requested_at as string | null) || new Date().toISOString(),
    leaseExpiresAt: (row.lease_expires_at as string | null) || null,
    attemptCount: Number(row.attempt_count || 0),
  };

  return jsonResponse(env, 200, { ok: true, data });
}

async function handleInternalJobStatus(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: JobStatusRequest;
  try {
    body = JSON.parse(rawBody) as JobStatusRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const claim = normalizePipelineClaim(body);
  const normalizedStatus = (body?.status || '').trim().toLowerCase();

  if (!claim) {
    return badRequest(env, 'jobId, claimToken, and runId are required');
  }

  if (!['running', 'completed', 'failed', 'canceled'].includes(normalizedStatus)) {
    return badRequest(env, 'invalid status');
  }

  const requestedStage = body.stage ?? null;
  if (![null, 'queued', 'fetching', 'extracting', 'clustering', 'publishing'].includes(requestedStage)) {
    return badRequest(env, 'invalid stage');
  }

  let result: Awaited<ReturnType<typeof completePipelineJob>>;
  try {
    result = await completePipelineJob(env, {
      ...claim,
      status: normalizedStatus as 'running' | 'completed' | 'failed' | 'canceled',
      stage: requestedStage,
      errorMessage:
        normalizedStatus === 'failed' ? 'The analysis failed. Retry the request.' : null,
    });
  } catch (error) {
    if (error instanceof UpstreamRequestError && error.upstreamCode === '23514') {
      return errorResponse(
        env,
        409,
        'pipeline_completion_rejected',
        '분석 결과가 아직 게시되지 않아 작업을 완료 상태로 바꾸지 않았습니다. 먼저 게시 단계를 완료하거나 실패나 취소 상태로 종료해 주세요.',
      );
    }
    throw error;
  }

  if (!result.updated) return jobClaimLost(env);

  const data = result.data || null;
  return jsonResponse(env, 200, { ok: true, data });
}

async function handleInternalPipelineHeartbeat(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) return unauthorized(env, 'invalid signature');

  let body: PipelineHeartbeatRequest;
  try {
    body = JSON.parse(rawBody) as PipelineHeartbeatRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const claim = normalizePipelineClaim(body);
  const stage = (body?.stage || '').toString().trim().toLowerCase();
  if (!claim || !['extracting', 'clustering'].includes(stage)) {
    return badRequest(env, 'jobId, claimToken, runId, and an active analysis stage are required');
  }

  const activeClaim = await renewPipelineJobClaim(
    env,
    claim,
    stage as PipelineHeartbeatRequest['stage'],
  );
  if (activeClaim?.status !== 'running') return jobClaimLost(env);

  return jsonResponse(env, 200, {
    ok: true,
    data: {
      status: 'running',
      stage,
      leaseExpiresAt: activeClaim.lease_expires_at || null,
    },
  });
}

async function handleInternalUpsertReviews(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) return unauthorized(env, 'invalid signature');

  let body: UpsertReviewRequest;
  try {
    body = JSON.parse(rawBody) as UpsertReviewRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const claim = normalizePipelineClaim(body);
  const appStoreId = normalizeAppStoreId(body?.app?.appStoreId);
  const country = normalizeCountry(body?.app?.country);
  if (!claim || !appStoreId || !body?.app?.country || !Array.isArray(body.reviews)) {
    return badRequest(env, 'jobId, claimToken, runId, app, and reviews are required');
  }

  const rejectReviewPersistence = async () => {
    const completion = await completePipelineJob(env, {
      ...claim,
      status: 'failed',
      errorMessage: 'The review persistence contract was rejected.',
    });
    if (!completion.updated) return jobClaimLost(env);
    return errorResponse(
      env,
      409,
      'pipeline_review_rejected',
      '리뷰를 현재 앱 범위에 안전하게 저장할 수 없어 작업을 중단했습니다. 앱과 국가 정보를 확인한 뒤 새 작업으로 다시 시도해 주세요.',
    );
  };

  if (body.reviews.length < 1 || body.reviews.length > MAX_FETCH_REVIEW_CAP) {
    return rejectReviewPersistence();
  }
  if (body.reviews.some((review) => !review || typeof review !== 'object')) {
    return rejectReviewPersistence();
  }
  const reviewIds = body.reviews.map((review) => String(review.reviewId || '').trim());
  if (reviewIds.some((reviewId) => !reviewId) || new Set(reviewIds).size !== reviewIds.length) {
    return rejectReviewPersistence();
  }

  const invalidReview = body.reviews.some((review) => {
    if (!review || typeof review !== 'object') return true;
    const rating = Number(review.rating);
    if (!Number.isFinite(rating) || !Number.isInteger(rating) || rating < 1 || rating > 5) return true;

    const reviewedAt = String(review.reviewedAt || '').trim();
    if (reviewedAt && !Number.isFinite(new Date(reviewedAt).getTime())) return true;

    if (review.confidence != null) {
      const confidence = Number(review.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return true;
    }
    return false;
  });
  if (invalidReview) return rejectReviewPersistence();

  const now = new Date().toISOString();
  const reviewRows = body.reviews.map((review) => {
    const rating = Number(review.rating);
    const reviewedAt = String(review.reviewedAt || '').trim();
    const summary = review.summary || '분류 결과 없음';
    const content = String(review.content || '');
    const normalizedCategory = normalizeVocCategory(review.category || '긍정 리뷰 및 기타', summary, content);
    const normalizedPriority = derivePriorityValue(rating, normalizedCategory, review.priority || 'Normal');
    return {
      review_id: String(review.reviewId || '').trim(),
      rating,
      author: String(review.author || 'unknown'),
      content,
      reviewed_at: reviewedAt ? new Date(reviewedAt).toISOString() : now,
      raw_source: review.rawSource || null,
      priority: normalizedPriority,
      category: normalizedCategory,
      issue_label: normalizeIssueLabel(review.issueLabel, normalizedCategory, summary),
      reason_summary: normalizeReasonSummary(review.reasonSummary, summary),
      action_hint: normalizeActionHint(review.actionHint, normalizedCategory),
      summary,
      confidence: review.confidence == null ? null : Number(review.confidence),
      model_version: review.modelVersion ?? 'gemini',
    };
  });

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await pipelineSupabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/persist_pipeline_reviews', {
      method: 'POST',
      body: JSON.stringify({
        p_job_id: claim.jobId,
        p_claim_token: claim.claimToken,
        p_run_id: claim.runId,
        p_app_store_id: appStoreId,
        p_country: country,
        p_app_name: normalizeOptionalText(body.app.appName, 120),
        p_source: normalizeOptionalText(body.source, 40) || 'n8n',
        p_reviews: reviewRows,
      }),
      idempotent: true,
      timeoutMs: 60_000,
      retries: 0,
    });
  } catch (error) {
    const upstreamCode = error instanceof UpstreamRequestError ? error.upstreamCode : null;
    if (upstreamCode?.startsWith('22') || upstreamCode?.startsWith('23') || upstreamCode === '21000') {
      return rejectReviewPersistence();
    }
    throw error;
  }
  if (!rows[0]) return jobClaimLost(env);

  return jsonResponse(env, 200, {
    ok: true,
    runId: claim.runId,
    upsertedReviews: Number(rows[0].upserted_reviews ?? reviewRows.length),
  });
}

async function handleInternalUpsertClusters(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) return unauthorized(env, 'invalid signature');

  let body: UpsertClustersRequest;
  try {
    body = JSON.parse(rawBody) as UpsertClustersRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const claim = normalizePipelineClaim(body);
  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  const country = normalizeCountry(body?.country);
  const modelVersion = normalizeOptionalText(body?.modelVersion, 120);
  const comparisonEligible = body?.comparisonEligible !== false;
  if (!claim || !appStoreId || !modelVersion || !Array.isArray(body.inputReviewIds)) {
    return badRequest(env, 'jobId, claimToken, runId, app scope, modelVersion, and inputReviewIds are required');
  }

  // persist_issue_clusters owns the atomic transition to publishing. This
  // guard must not move an already-persisted retry back to clustering when the
  // first response was lost after the database commit.
  const activeClaim = await renewPipelineJobClaim(env, claim);
  if (activeClaim?.status !== 'running') return jobClaimLost(env);

  let validated;
  try {
    validated = validateClusterContract(body.inputReviewIds, body.result);
  } catch {
    const completion = await completePipelineJob(env, {
      ...claim,
      status: 'failed',
      errorMessage: 'The cluster result was invalid. Retry the request.',
    });
    if (!completion.updated) return jobClaimLost(env);
    return errorResponse(
      env,
      422,
      'cluster_contract_invalid',
      '클러스터 분석 결과를 검증하지 못했습니다. 작업은 실패 상태이며 다시 요청할 수 있습니다.',
    );
  }

  const reviewIds = validated.extractions.map((item) => item.reviewId);
  const lookup = await fetchScopedReviewRows<Record<string, unknown>>(
    env,
    claim,
    reviewIds,
    null,
    { appStoreId, country },
    false,
  );
  if (lookup.status === 'claim_lost') return jobClaimLost(env);
  const reviewRows = lookup.rows;
  const reviewedAtById = new Map(reviewRows.map((row) => [String(row.review_id || ''), String(row.reviewed_at || '')]));
  const missingReviewIds = reviewIds.filter((id) => !reviewedAtById.has(id));
  if (lookup.status === 'invalid' || missingReviewIds.length > 0) {
    const completion = await completePipelineJob(env, {
      ...claim,
      status: 'failed',
      errorMessage: 'The cluster input reviews were unavailable. Retry the request.',
    });
    if (!completion.updated) return jobClaimLost(env);
    return errorResponse(
      env,
      422,
      'unknown_review_ids',
      '클러스터 입력 리뷰를 확인하지 못했습니다. 작업은 실패 상태이며 다시 요청할 수 있습니다.',
    );
  }

  const now = new Date().toISOString();
  const clusterRows = validated.clusters.map((cluster) => {
    const occurrences = cluster.reviewIds
      .map((id) => reviewedAtById.get(id) || now)
      .filter((value) => Number.isFinite(new Date(value).getTime()))
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    return {
      existing_cluster_id: cluster.existingClusterId,
      canonical_key: cluster.canonicalKey,
      title: cluster.title,
      category: cluster.category,
      severity: cluster.severity,
      summary: cluster.summary,
      action_hint: cluster.actionHint,
      review_ids: cluster.reviewIds,
      representative_review_ids: cluster.representativeReviewIds,
      first_seen_at: occurrences[0] || now,
      last_seen_at: occurrences[occurrences.length - 1] || now,
    };
  });
  const validationResult = { ...validated.validation, comparisonEligible };

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await pipelineSupabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/persist_issue_clusters', {
      method: 'POST',
      body: JSON.stringify({
        p_job_id: claim.jobId,
        p_claim_token: claim.claimToken,
        p_run_id: claim.runId,
        p_app_store_id: appStoreId,
        p_country: country,
        p_model_version: modelVersion,
        p_window_from: body.windowFrom || null,
        p_window_to: body.windowTo || null,
        p_comparison_eligible: comparisonEligible,
        p_clusters: clusterRows,
        p_validation_result: validationResult,
      }),
      idempotent: true,
      timeoutMs: 60_000,
      retries: 0,
    });
  } catch (error) {
    if (error instanceof UpstreamRequestError && error.upstreamCode === '23514') {
      const completion = await completePipelineJob(env, {
        ...claim,
        status: 'failed',
        errorMessage: 'Cluster persistence was rejected. Retry the request.',
      });
      if (!completion.updated) return jobClaimLost(env);
      return errorResponse(
        env,
        422,
        'cluster_persistence_rejected',
        '클러스터 결과를 저장하지 못했습니다. 기존 공개 리포트는 유지되며 다시 요청할 수 있습니다.',
      );
    }
    throw error;
  }
  if (!rows[0]) return jobClaimLost(env);

  return jsonResponse(env, 200, {
    ok: true,
    runId: claim.runId,
    clusterCount: Number(rows[0].cluster_count ?? clusterRows.length),
    assignedReviewCount: Number(rows[0].assigned_review_count ?? reviewIds.length),
    validation: validationResult,
  });
}

async function handleInternalClusterContext(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) return unauthorized(env, 'invalid signature');
  let body: ClusterContextRequest;
  try {
    body = JSON.parse(rawBody) as ClusterContextRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }
  const claim = normalizePipelineClaim(body);
  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  const country = normalizeCountry(body?.country);
  if (!claim || !appStoreId) return badRequest(env, 'job claim and numeric appStoreId are required');
  const activeClaim = await renewPipelineJobClaim(env, claim, 'clustering');
  if (activeClaim?.status !== 'running') return jobClaimLost(env);
  const payload = await pipelineSupabaseRequest<unknown>(
    env,
    '/rest/v1/rpc/get_pipeline_cluster_context_v2',
    {
      method: 'POST',
      body: JSON.stringify({ p_app_store_id: appStoreId, p_country: country }),
      idempotent: true,
    },
  );
  const rows = unwrapJsonbArray<Record<string, unknown>>(payload, 'get_pipeline_cluster_context_v2');
  if (!rows || rows.length > MAX_FETCH_REVIEW_CAP) {
    return errorResponse(
      env,
      502,
      'cluster_context_invalid',
      '클러스터 기준 데이터를 확인하지 못했습니다. 기존 공개 리포트는 유지되며 작업을 다시 시도할 수 있습니다.',
      true,
    );
  }

  const seenIssueIds = new Set<string>();
  const data: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const issueId = String(row.issue_id || '').trim();
    const canonicalKey = String(row.canonical_key || '').trim();
    const title = String(row.title || '').trim();
    const category = String(row.category || '').trim();
    const summary = String(row.summary || '').trim();
    const firstSeenAt = String(row.first_seen_at || '').trim();
    const lastSeenAt = String(row.last_seen_at || '').trim();
    const reviewCount = Number(row.review_count);
    if (
      !isUuid(issueId)
      || seenIssueIds.has(issueId)
      || !canonicalKey
      || canonicalKey.length > 160
      || !title
      || title.length > 120
      || normalizeVocCategory(category, '', '') !== category
      || !summary
      || summary.length > 400
      || !Number.isFinite(new Date(firstSeenAt).getTime())
      || !Number.isFinite(new Date(lastSeenAt).getTime())
      || !Number.isInteger(reviewCount)
      || reviewCount < 1
    ) {
      return errorResponse(
        env,
        502,
        'cluster_context_invalid',
        '클러스터 기준 데이터를 확인하지 못했습니다. 기존 공개 리포트는 유지되며 작업을 다시 시도할 수 있습니다.',
        true,
      );
    }
    seenIssueIds.add(issueId);
    data.push({
      issueId,
      canonicalKey,
      title,
      category,
      summary,
      firstSeenAt,
      lastSeenAt,
      reviewCount,
    });
  }

  const freshClaim = await renewPipelineJobClaim(env, claim, 'clustering');
  if (freshClaim?.status !== 'running') return jobClaimLost(env);
  return jsonResponse(env, 200, {
    ok: true,
    data,
  });
}

async function handleInternalParseError(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) return unauthorized(env, 'invalid signature');

  let body: ParseErrorRequest;
  try {
    body = JSON.parse(rawBody) as ParseErrorRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const claim = normalizePipelineClaim(body);
  if (!claim || !body?.parseErrorId || !body?.message) {
    return badRequest(env, 'job claim, parseErrorId, and message are required');
  }

  const rows = await pipelineSupabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/record_pipeline_parse_error', {
    method: 'POST',
    body: JSON.stringify({
      p_job_id: claim.jobId,
      p_claim_token: claim.claimToken,
      p_run_id: claim.runId,
      p_parse_error_id: normalizeOptionalText(body.parseErrorId, 200),
      p_app_store_id: normalizeAppStoreId(body.appStoreId) || null,
      p_country: body.country ? normalizeCountry(body.country) : null,
      p_message: normalizeOptionalText(body.message, 1000) || 'Pipeline output parse failed',
      p_raw_response: String(body.rawResponse || '').slice(0, 8000),
    }),
    idempotent: true,
  });
  if (!rows[0]) return jobClaimLost(env);

  return jsonResponse(env, 200, { ok: true, parseErrorId: body.parseErrorId });
}

async function handleInternalPublish(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) return unauthorized(env, 'invalid signature');

  let body: PublishRequest;
  try {
    body = JSON.parse(rawBody) as PublishRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const claim = normalizePipelineClaim(body);
  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  const country = normalizeCountry(body?.country);
  if (!claim || !appStoreId || !body?.country) {
    return badRequest(env, 'job claim and app scope are required');
  }

  const requestedPublishedAt = normalizeOptionalText(body.publishedAt, 80);
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await pipelineSupabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/publish_pipeline_run', {
      method: 'POST',
      body: JSON.stringify({
        p_job_id: claim.jobId,
        p_claim_token: claim.claimToken,
        p_run_id: claim.runId,
        p_app_store_id: appStoreId,
        p_country: country,
        p_published_at: requestedPublishedAt || new Date().toISOString(),
      }),
      idempotent: true,
    });
  } catch (error) {
    if (error instanceof UpstreamRequestError && error.upstreamCode === '23514') {
      const completion = await completePipelineJob(env, {
        ...claim,
        status: 'failed',
        errorMessage: 'The analysis result was not publishable. Retry the request.',
      });
      if (!completion.updated) return jobClaimLost(env);
      return errorResponse(
        env,
        409,
        'cluster_validation_required',
        '검증된 분석 결과가 없어 게시하지 않았습니다. 기존 공개 리포트는 유지됩니다.',
      );
    }
    throw error;
  }
  if (!rows[0]) return jobClaimLost(env);

  await setCacheVersion(env, String(Date.now()));
  return jsonResponse(env, 200, {
    ok: true,
    runId: claim.runId,
    publishedAt: rows[0].published_at || requestedPublishedAt,
  });
}

async function handleInternalAlertEvents(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: AlertEventsRequest;
  try {
    body = JSON.parse(rawBody) as AlertEventsRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const claim = normalizePipelineClaim(body);
  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  const normalizedCountry = normalizeCountry(body.country);
  if (!claim || !appStoreId || !body?.country || !Array.isArray(body.alerts)) {
    return badRequest(env, 'job claim, app scope, and alerts are required');
  }

  const rows = body.alerts.map((alert) => {
    const normalizedCategory = normalizeVocCategory(alert.category, alert.summary, '');
    const normalizedPriority = derivePriorityValue(alert.rating, normalizedCategory, alert.priority);

    return {
      event_id: `${appStoreId}_${normalizedCountry}_${alert.reviewId}`,
      review_id: alert.reviewId,
      rating: alert.rating,
      priority: normalizedPriority,
      category: normalizedCategory,
      summary: alert.summary,
      sent_at: alert.sentAt || new Date().toISOString(),
    };
  });

  const persisted = await pipelineSupabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/persist_pipeline_alerts', {
    method: 'POST',
    body: JSON.stringify({
      p_job_id: claim.jobId,
      p_claim_token: claim.claimToken,
      p_run_id: claim.runId,
      p_app_store_id: appStoreId,
      p_country: normalizedCountry,
      p_alerts: rows,
    }),
    idempotent: true,
  });
  if (!persisted[0]) return jobClaimLost(env);

  return jsonResponse(env, 200, { ok: true, inserted: Number(persisted[0].inserted ?? rows.length) });
}

/** Returns null when the request is not an internal pipeline route. */
export async function routeInternalRequest(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST') return null;
  const routes: Record<string, (rawBody: string) => Promise<Response>> = {
    '/api/internal/pipeline/claim-job': (rawBody) => handleInternalClaimJob(env, request, rawBody),
    '/api/internal/pipeline/fetch-reviews': (rawBody) => handleInternalFetchReviews(env, request, rawBody),
    '/api/internal/pipeline/job-status': (rawBody) => handleInternalJobStatus(env, request, rawBody),
    '/api/internal/pipeline/heartbeat': (rawBody) => handleInternalPipelineHeartbeat(env, request, rawBody),
    '/api/internal/pipeline/filter-new-reviews': (rawBody) => handleInternalFilterNewReviews(env, request, rawBody),
    '/api/internal/pipeline/upsert-reviews': (rawBody) => handleInternalUpsertReviews(env, request, rawBody),
    '/api/internal/pipeline/upsert-clusters': (rawBody) => handleInternalUpsertClusters(env, request, rawBody),
    '/api/internal/pipeline/cluster-context': (rawBody) => handleInternalClusterContext(env, request, rawBody),
    '/api/internal/pipeline/parse-error': (rawBody) => handleInternalParseError(env, request, rawBody),
    '/api/internal/pipeline/publish': (rawBody) => handleInternalPublish(env, request, rawBody),
    '/api/internal/pipeline/alert-events': (rawBody) => handleInternalAlertEvents(env, request, rawBody),
  };
  const handler = routes[url.pathname];
  return handler ? handler(await request.text()) : null;
}
