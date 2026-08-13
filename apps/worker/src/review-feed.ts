import type { Env } from './types';
import {
  badRequest,
  buildReviewFeedFilters,
  clampLimit,
  decodeReviewFeedCursor,
  errorResponse,
  isLegacyTimestampCursor,
  jsonResponse,
  normalizeAppStoreId,
  normalizeCountry,
  normalizeOptionalText,
  normalizePriorityFilter,
  normalizeReviewFeedRows,
  normalizeSearchKeyword,
  normalizeTimestampFilter,
  parsePage,
  parsePrivateReviewSortBy,
  parseRatingFilter,
  parseSortDirection,
  supabaseRequest,
} from './platform';

export type ReviewFeedPolicy = 'public' | 'private';

/**
 * Executes the common review-feed query after the owning route has applied its
 * authorization policy. Public-only filters remain unavailable to private callers.
 */
export async function executeReviewFeed(
  env: Env,
  request: Request,
  policy: ReviewFeedPolicy,
): Promise<Response> {
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
  const publicPolicy = policy === 'public';
  const searchScope = publicPolicy && searchParams.get('searchScope') === 'content' ? 'content' : 'all';
  const rawFrom = publicPolicy ? searchParams.get('from') : null;
  const rawTo = publicPolicy ? searchParams.get('to') : null;
  const from = normalizeTimestampFilter(rawFrom);
  const to = normalizeTimestampFilter(rawTo);

  if (!appId) return badRequest(env, 'appId must be numeric');
  if (rawFrom !== null && !from) return badRequest(env, 'from must be a valid timestamp');
  if (rawTo !== null && !to) return badRequest(env, 'to must be a valid timestamp');
  if (from && to && Date.parse(from) > Date.parse(to)) {
    return badRequest(env, 'from must not be after to');
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
    searchScope,
    from,
    to,
    cursor,
  });
  const rows = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/private_review_feed?${filters.toString()}`,
    { method: 'GET', idempotent: true },
  );
  const normalized = normalizeReviewFeedRows(rows, limit, sortBy);
  return jsonResponse(env, 200, {
    data: normalized.data,
    page,
    limit,
    hasNext: normalized.hasNext,
    nextCursor: normalized.nextCursor,
  });
}
