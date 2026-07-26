import type {
  AlertEventsRequest, ClaimJobRequest, ClusterContextRequest, Env, FetchReviewsRequest, FilterNewReviewsRequest, JobStatusRequest, ParseErrorRequest, PublishRequest, UpsertClustersRequest, UpsertReviewRequest,
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
  DEFAULT_FETCH_WINDOW_DAYS,
  MAX_FETCH_WINDOW_DAYS,
  MAX_FETCH_MAX_PAGES,
  DEFAULT_FETCH_MAX_PAGES,
  MAX_FETCH_REVIEW_CAP,
  ITUNES_USER_REVIEW_PAGE_SIZE,
} from './platform';

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
  let rssFirstPageError: string | null = null;

  for (let page = 1; page <= maxPages && reviews.length < limitCap; page += 1) {
    if (page > 1 && page % 10 === 1) {
      const heartbeat = await renewPipelineJobClaim(env, claim, 'fetching');
      if (heartbeat?.status !== 'running') return jobClaimLost(env);
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
      timeoutMs: 30000,
      retries: 2,
      idempotent: true,
    });

    if (!response.ok) {
      if (page === 1) {
        rssFirstPageError = `iTunes RSS fetch failed (${response.status})`;
      }
      break;
    }

    pagesFetched += 1;

    let payload: Record<string, unknown> = {};
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      if (page === 1) {
        throw new Error('iTunes response parse failed');
      }
      break;
    }

    const feed = payload.feed as Record<string, unknown> | undefined;
    const entries = Array.isArray(feed?.entry) ? (feed.entry as Array<Record<string, unknown>>) : [];
    if (entries.length === 0) {
      break;
    }

    let addedInPage = 0;
    let reachedOlderReviews = false;
    for (const entry of entries) {
      const reviewId = String((entry.id as { label?: string } | undefined)?.label ?? entry.id ?? '').trim();
      const rating = normalizeRating((entry['im:rating'] as { label?: string } | undefined)?.label ?? entry['im:rating']);
      const reviewedAt = normalizeReviewedAt((entry.updated as { label?: string } | undefined)?.label ?? entry.updated);
      const reviewedAtMs = new Date(reviewedAt).getTime();

      if (!reviewId || rating <= 0 || seenIds.has(reviewId)) {
        continue;
      }
      if (!Number.isFinite(reviewedAtMs) || reviewedAtMs < cutoff) {
        reachedOlderReviews = true;
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
        break;
      }
    }

    if (reachedOlderReviews) {
      break;
    }
    if (addedInPage === 0) {
      break;
    }
  }

  // Some apps or Apple edge locations return an empty/blocked RSS feed.
  // The storefront review-row endpoint is the current fallback for the KR storefront.
  if (reviews.length === 0 && country === 'kr') {
    for (let page = 0; page < maxPages && reviews.length < limitCap; page += 1) {
      if (page > 0 && page % 10 === 0) {
        const heartbeat = await renewPipelineJobClaim(env, claim, 'fetching');
        if (heartbeat?.status !== 'running') return jobClaimLost(env);
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
        timeoutMs: 30000,
        retries: 2,
        idempotent: true,
      });

      if (!response.ok) {
        if (page === 0 && rssFirstPageError) {
          throw new Error(rssFirstPageError);
        }
        break;
      }

      const payload = (await response.json()) as {
        userReviewList?: Array<Record<string, unknown>>;
      };
      const entries = Array.isArray(payload.userReviewList) ? payload.userReviewList : [];
      if (entries.length === 0) {
        break;
      }

      pagesFetched += 1;
      let reachedOlderReviews = false;
      for (const entry of entries) {
        const reviewId = String(entry.userReviewId || '').trim();
        const rating = normalizeRating(entry.rating);
        const reviewedAt = normalizeReviewedAt(entry.date);
        const reviewedAtMs = new Date(reviewedAt).getTime();

        if (!reviewId || rating <= 0 || seenIds.has(reviewId)) {
          continue;
        }
        if (!Number.isFinite(reviewedAtMs) || reviewedAtMs < cutoff) {
          reachedOlderReviews = true;
          continue;
        }

        seenIds.add(reviewId);
        reviews.push({
          reviewId,
          author: String(entry.name || 'unknown').trim(),
          content: String(entry.body || '').trim(),
          rating,
          reviewedAt,
        });

        if (reviews.length >= limitCap) {
          truncated = true;
          break;
        }
      }

      if (reachedOlderReviews) {
        break;
      }
    }
  }

  if (reviews.length === 0 && rssFirstPageError) {
    throw new Error(rssFirstPageError);
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
      truncated,
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

  // 이미 적재된 review_id를 먼저 제외해서 중복 분석/중복 저장을 막는다.
  const existingRows = await supabaseRequest<Array<{ review_id: string }>>(env, '/rest/v1/rpc/get_existing_review_ids', {
    method: 'POST',
    body: JSON.stringify({
      p_app_store_id: appStoreId,
      p_country: country,
      p_review_ids: normalizedReviews.map((review) => review.reviewId),
    }),
    idempotent: true,
  });

  const existingIds = new Set(existingRows.map((row) => row.review_id));
  const freshReviews = normalizedReviews.filter((review) => !existingIds.has(review.reviewId));
  const incomingReviewsById = new Map(normalizedReviews.map((review) => [review.reviewId, review]));
  let existingExtractions: Array<Record<string, unknown>> = [];
  if (forceReanalysis && existingIds.size > 0) {
    const idFilter = [...existingIds].map((id) => encodeURIComponent(id)).join(',');
    const rows = await supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/private_review_feed?select=review_id,rating,author,content,reviewed_at,priority,category,summary&review_id=in.(${idFilter})`,
      { method: 'GET', idempotent: true },
    );
    existingExtractions = rows.map((row) => {
      const incoming = incomingReviewsById.get(String(row.review_id || ''));
      return {
        ID: row.review_id,
        id: row.review_id,
        rating: incoming?.rating ?? row.rating,
        author: incoming?.author ?? row.author,
        content: incoming?.content ?? row.content,
        date: incoming?.reviewedAt ?? row.reviewed_at,
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
  } else {
    const heartbeat = await renewPipelineJobClaim(env, claim, 'extracting');
    if (heartbeat?.status !== 'running') return jobClaimLost(env);
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

  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/claim_pipeline_job', {
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
    rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/persist_pipeline_reviews', {
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

  const activeClaim = await renewPipelineJobClaim(env, claim, 'clustering');
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
  const reviewFilter = reviewIds.map((id) => encodeURIComponent(id)).join(',');
  const reviewRows = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    '/rest/v1/reviews?select=review_id,reviewed_at&app_store_id=eq.' + encodeURIComponent(appStoreId)
      + '&country=eq.' + encodeURIComponent(country) + '&review_id=in.(' + reviewFilter + ')',
    { method: 'GET', idempotent: true },
  );
  const reviewedAtById = new Map(reviewRows.map((row) => [String(row.review_id || ''), String(row.reviewed_at || '')]));
  const missingReviewIds = reviewIds.filter((id) => !reviewedAtById.has(id));
  if (missingReviewIds.length > 0) {
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
    rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/persist_issue_clusters', {
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
  const data = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    '/rest/v1/rpc/get_pipeline_cluster_context',
    {
      method: 'POST',
      body: JSON.stringify({ p_app_store_id: appStoreId, p_country: country }),
      idempotent: true,
    },
  );
  return jsonResponse(env, 200, {
    ok: true,
    data: data.map((row) => ({
      issueId: row.issue_id,
      canonicalKey: row.canonical_key,
      title: row.title,
      category: row.category,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    })),
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

  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/record_pipeline_parse_error', {
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
    rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/publish_pipeline_run', {
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

  const persisted = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/persist_pipeline_alerts', {
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
