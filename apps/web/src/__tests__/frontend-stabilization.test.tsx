import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AccountDeletionPanel,
  ACCOUNT_DELETE_CONFIRMATION,
  getAccountDeletionRecoveryMessage,
  isAccountDeletionConfirmed,
} from '@/components/Shell';
import { getOwnedSearchResult, moveSearchResultIndex } from '@/components/GlobalSearch';
import {
  ANALYSIS_REQUEST_SESSION_MESSAGE,
  getAnalysisRequestFailureMessage,
} from '@/lib/analysisRequestError';
import {
  ApiError,
  deleteAccount,
  discoverApps,
  getIssueDetail,
  getPublicReport,
  getPublicReviews,
  parseApiIntegerConfig,
} from '@/lib/api';
import { getIssueAccessibleName, mergeReviewItems } from '@/routes/AppReportPage';
import {
  canRetryPipelineJob,
  getPipelineJobFailureMessage,
  getPipelineStagePresentation,
  hasActivePipelineJobs,
} from '@/routes/RequestsPage';
import type { DiscoveryItem, IssueClusterItem, PipelineJobItem, PublicReport, ReviewItem } from '@/types';

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const discoveryFixture: DiscoveryItem = {
  appStoreId: '123456789',
  country: 'kr',
  appName: 'Fixture App',
  artworkUrl: null,
  bundleId: null,
  developerName: 'Fixture Developer',
  analyzed: true,
  lastAnalyzedAt: null,
  source: 'catalog',
};

const reviewFixture = (reviewId: string, content = reviewId): ReviewItem => ({
  review_id: reviewId,
  app_store_id: '123456789',
  country: 'kr',
  rating: 3,
  author: 'tester',
  content,
  reviewed_at: '2026-07-01T00:00:00.000Z',
  priority: 'Normal',
  category: '기능 및 사용성',
  issue_label: 'fixture',
  reason_summary: 'fixture',
  action_hint: 'fixture',
  summary: 'fixture',
  confidence: null,
});

const reportFixture: PublicReport = {
  window: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-30T23:59:59.999Z' },
  app: { appStoreId: '123456789', country: 'kr', appName: 'Fixture App', artworkUrl: null },
  summary: {
    totalReviews: 1,
    issueCount: 0,
    averageRating: 3,
    lowRatingCount: 0,
    lowRatingRatio: 0,
    positiveRatio: 0,
    lastReviewAt: '2026-07-01T00:00:00.000Z',
  },
  analysis: {
    status: 'analyzed',
    runId: 'run-fixture',
    modelVersion: 'model-fixture',
    lastAnalyzedAt: '2026-07-01T00:00:00.000Z',
    stale: false,
  },
  issues: [],
  categories: [],
  trends: [],
};

const jobFixture = (status: PipelineJobItem['status']): PipelineJobItem => ({
  id: `job-${status}`,
  app_store_id: '123456789',
  country: 'kr',
  app_name: 'Fixture App',
  source: 'user',
  status,
  run_id: null,
  note: null,
  error_message: 'INTERNAL_PROVIDER_DETAIL internal-model-name',
  requested_at: '2026-07-01T00:00:00.000Z',
  started_at: null,
  finished_at: null,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
});

const relativeLuminance = (hex: string) => {
  const channels = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

const contrastRatio = (foreground: string, background: string) => {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
};

async function main() {
  await test('account deletion requires the exact confirmation phrase and explains partial failure recovery', () => {
    assert.equal(ACCOUNT_DELETE_CONFIRMATION, '탈퇴');
    assert.equal(isAccountDeletionConfirmed('탈퇴'), true);
    assert.equal(isAccountDeletionConfirmed(' 탈퇴'), false);
    assert.equal(isAccountDeletionConfirmed('탈퇴 '), false);

    const unconfirmed = renderToStaticMarkup(<AccountDeletionPanel
      confirmation="탈"
      deleting={false}
      accountDeleted={false}
      error={null}
      onConfirmationChange={() => {}}
      onCancel={() => {}}
      onDelete={() => {}}
      onReload={() => {}}
    />);
    const failed = renderToStaticMarkup(<AccountDeletionPanel
      confirmation="탈퇴"
      deleting={false}
      accountDeleted={false}
      error="계정은 현재 유지됩니다. 진행 중인 분석 요청은 일부 취소되었을 수 있습니다. 다시 시도하세요."
      onConfirmationChange={() => {}}
      onCancel={() => {}}
      onDelete={() => {}}
      onReload={() => {}}
    />);
    const localCleanupFailed = renderToStaticMarkup(<AccountDeletionPanel
      confirmation="탈퇴"
      deleting={false}
      accountDeleted={true}
      error="계정 삭제는 완료됐지만 이 기기에서 로그아웃하지 못했습니다."
      onConfirmationChange={() => {}}
      onCancel={() => {}}
      onDelete={() => {}}
      onReload={() => {}}
    />);

    assert.match(unconfirmed, /account-delete-panel__submit" disabled=""/);
    assert.match(failed, /account-delete-panel__submit" aria-busy="false"/);
    assert.match(unconfirmed, /<strong>탈퇴<\/strong>를 정확히 입력/);
    assert.match(failed, /role="alert"/);
    assert.match(failed, /계정은 현재 유지됩니다/);
    assert.match(failed, /다시 시도하세요/);
    assert.match(localCleanupFailed, /<input[^>]+disabled=""/);
    assert.match(localCleanupFailed, />새로고침<\/button>/);
    assert.doesNotMatch(localCleanupFailed, /영구 탈퇴/);

    const notStarted = getAccountDeletionRecoveryMessage(new ApiError('hidden', {
      code: 'account_delete_not_started',
    }));
    const incomplete = getAccountDeletionRecoveryMessage(new ApiError('hidden', {
      code: 'account_delete_incomplete',
    }));
    assert.match(notStarted, /계정은 유지/);
    assert.match(notStarted, /요청 취소와 요청 메모 삭제 여부를 확인하지 못했습니다/);
    assert.match(notStarted, /다시 시도하세요/);
    assert.match(incomplete, /요청 취소와 메모 삭제는 완료/);
    assert.match(incomplete, /계정 삭제 결과는 확인하지 못했습니다/);
    assert.match(incomplete, /계정이 남아 있으면 다시 시도/);

    const shellSource = readFileSync('src/components/Shell.tsx', 'utf8');
    const authSource = readFileSync('src/lib/auth.ts', 'utf8');
    assert.match(shellSource, /error\.code === 'account_delete_not_started'/);
    assert.match(shellSource, /error\.code === 'account_delete_incomplete'/);
    assert.match(shellSource, /계정 탈퇴 결과를 확인하지 못했습니다/);
    assert.match(shellSource, /계정이 남아 있으면 다시 시도하세요/);
    assert.match(shellSource, /계정 삭제는 완료됐지만 이 기기에서 로그아웃하지 못했습니다/);
    assert.match(shellSource, /await clearLocalSession\(\)/);
    assert.match(authSource, /signOut\(\{ scope: 'local' \}\)/);
    assert.match(authSource, /const \{ error \} = await supabase\.auth\.signOut\(\);\s*if \(error\) \{\s*throw error/);
  });

  await test('deleteAccount uses DELETE with the bearer token', async () => {
    const originalFetch = globalThis.fetch;
    let request: { url: string; method?: string; authorization?: string } | null = null;
    globalThis.fetch = (async (input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      request = {
        url: String(input),
        method: init?.method,
        authorization: headers?.Authorization,
      };
      return new Response(JSON.stringify({ ok: true, data: { deleted: true, canceledJobs: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const response = await deleteAccount('fixture-token');
      assert.equal(response.data.canceledJobs, 2);
      assert.deepEqual(request, {
        url: '/api/private/account',
        method: 'DELETE',
        authorization: 'Bearer fixture-token',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('API errors parse the typed envelope without exposing malformed raw bodies', async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response(JSON.stringify({
        ok: false,
        error: 'job_claim_lost',
        message: '요청 소유권이 만료되었습니다.',
        requestId: 'request-fixture',
        retryable: false,
      }), { status: 409, headers: { 'content-type': 'application/json' } }),
      new Response('INTERNAL_PROVIDER_DETAIL=<private>', {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      }),
    ];
    globalThis.fetch = (async () => responses.shift() as Response) as typeof fetch;

    try {
      await assert.rejects(
        () => getPublicReport('123456789'),
        (error: unknown) => error instanceof ApiError
          && error.code === 'job_claim_lost'
          && error.requestId === 'request-fixture'
          && error.message === '요청 소유권이 만료되었습니다.',
      );
      await assert.rejects(
        () => getPublicReport('123456789'),
        (error: unknown) => error instanceof ApiError
          && !error.message.includes('INTERNAL_PROVIDER_DETAIL')
          && !error.message.includes('<private>'),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('HTML error pages are retried only as safe typed errors', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('<html>INTERNAL_PROVIDER_DETAIL=<private></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => getPublicReport('123456789'),
        (error: unknown) => error instanceof ApiError
          && error.code === 'invalid_response'
          && error.message === '서비스 응답을 처리하지 못했습니다.'
          && !error.message.includes('INTERNAL_PROVIDER_DETAIL'),
      );
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('search results remain owned by their query and keyboard movement wraps predictably', () => {
    assert.equal(getOwnedSearchResult('new query', 'old query', [discoveryFixture]), null);
    assert.equal(getOwnedSearchResult(' fixture ', 'fixture', [discoveryFixture]), discoveryFixture);
    assert.equal(moveSearchResultIndex(-1, 3, 'next'), 0);
    assert.equal(moveSearchResultIndex(2, 3, 'next'), 0);
    assert.equal(moveSearchResultIndex(-1, 3, 'previous'), 2);
    assert.equal(moveSearchResultIndex(0, 3, 'previous'), 2);

  });

  await test('malformed 200 report, review, and issue payloads fail before render', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ data: { unexpected: true } })) as typeof fetch;

    const isInvalidResponse = (error: unknown) => error instanceof ApiError
      && error.status === 200
      && error.code === 'invalid_response'
      && error.message === '서비스 응답을 처리하지 못했습니다.';
    try {
      await assert.rejects(() => getPublicReport('123456789'), isInvalidResponse);
      await assert.rejects(() => getPublicReviews('123456789'), isInvalidResponse);
      await assert.rejects(
        () => getIssueDetail(
          '11111111-1111-4111-8111-111111111111',
          reportFixture.window.from,
          reportFixture.window.to,
        ),
        isInvalidResponse,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('caller cancellation reaches fetch and is never retried', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let calls = 0;
    let receivedSignal: AbortSignal | null = null;
    globalThis.fetch = ((_, init) => {
      calls += 1;
      receivedSignal = init?.signal || null;
      return new Promise<Response>((_, reject) => {
        receivedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;

    try {
      const request = discoverApps('fixture', 'kr', 8, controller.signal);
      controller.abort();
      await assert.rejects(
        () => request,
        (error: unknown) => error instanceof ApiError && error.code === 'request_aborted' && !error.retryable,
      );
      assert.equal((receivedSignal as AbortSignal | null)?.aborted, true);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('API timeout and retry config preserve valid integers without imposing a cap', () => {
    assert.equal(parseApiIntegerConfig('25000', 10000, 1), 25000);
    assert.equal(parseApiIntegerConfig('2147483647', 10000, 1, 2_147_483_647), 2_147_483_647);
    assert.equal(parseApiIntegerConfig('2147483648', 10000, 1, 2_147_483_647), 10000);
    assert.equal(parseApiIntegerConfig('12', 2, 0), 12);
    assert.equal(parseApiIntegerConfig(String(Number.MAX_SAFE_INTEGER), 2, 0), Number.MAX_SAFE_INTEGER);
    assert.equal(parseApiIntegerConfig('0', 2, 0), 0);
    for (const invalid of ['', 'NaN', 'Infinity', '1.5', '-1', Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(parseApiIntegerConfig(invalid, 2, 0), 2);
    }
    assert.equal(parseApiIntegerConfig('0', 10000, 1), 10000);
  });

  await test('review pagination deduplicates cursor overlap', () => {
    const first = reviewFixture('review-1', 'first');
    const overlapping = reviewFixture('review-1', 'new duplicate');
    const second = reviewFixture('review-2', 'second');
    assert.deepEqual(mergeReviewItems([first], [overlapping, second]), [first, second]);

  });

  await test('report returns the Worker-canonical window for dependent requests', async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      if (requests.length === 1) return Response.json({ data: reportFixture });
      if (requests.length === 2) {
        return Response.json({
          data: {
            issue: {
              issueId: '11111111-1111-4111-8111-111111111111',
              appStoreId: '123456789',
              country: 'kr',
              title: 'fixture',
              category: 'fixture',
              severity: 'low',
              reviewCount: 0,
              changePercent: null,
              evidenceCount: 0,
              lastOccurredAt: null,
              summary: 'fixture',
              actionHint: null,
              runId: 'run-fixture',
              modelVersion: 'model-fixture',
              validation: {},
              analyzedAt: null,
            },
            reviews: [],
          },
        });
      }
      return Response.json({ data: [], page: 1, limit: 50, hasNext: false, nextCursor: null });
    }) as typeof fetch;

    try {
      const report = await getPublicReport('123456789', 'kr');
      await getIssueDetail(
        '11111111-1111-4111-8111-111111111111',
        report.data.window.from,
        report.data.window.to,
      );
      await getPublicReviews('123456789', {
        country: 'kr',
        from: report.data.window.from,
        to: report.data.window.to,
        search: 'fixture',
        searchScope: 'content',
      });
      await getPublicReviews('123456789', { country: 'kr', search: 'fixture' });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const reportUrl = new URL(requests[0]!, 'https://example.test');
    const issueDetailUrl = new URL(requests[1]!, 'https://example.test');
    const scopedReviewsUrl = new URL(requests[2]!, 'https://example.test');
    const compatibleReviewsUrl = new URL(requests[3]!, 'https://example.test');
    assert.equal(reportUrl.searchParams.has('from'), false);
    assert.equal(reportUrl.searchParams.has('to'), false);
    assert.equal(issueDetailUrl.searchParams.get('from'), reportFixture.window.from);
    assert.equal(issueDetailUrl.searchParams.get('to'), reportFixture.window.to);
    assert.equal(scopedReviewsUrl.searchParams.get('from'), reportFixture.window.from);
    assert.equal(scopedReviewsUrl.searchParams.get('to'), reportFixture.window.to);
    assert.equal(scopedReviewsUrl.searchParams.get('searchScope'), 'content');
    assert.equal(compatibleReviewsUrl.searchParams.has('from'), false);
    assert.equal(compatibleReviewsUrl.searchParams.has('to'), false);
    assert.equal(compatibleReviewsUrl.searchParams.has('searchScope'), false);
  });

  await test('discovery uses the canonical request without browser-owned artwork revision', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    globalThis.fetch = (async (input) => {
      requestUrl = String(input);
      return Response.json({ data: [] });
    }) as typeof fetch;

    try {
      await discoverApps('', 'kr', 6);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(new URL(requestUrl, 'https://example.test').searchParams.has('artworkRevision'), false);
  });

  await test('issue rows expose every meaningful cell', () => {
    const issue: IssueClusterItem = {
      issueId: '11111111-1111-4111-8111-111111111111',
      title: '앱 실행 오류',
      category: '버그 및 성능',
      severity: 'high',
      reviewCount: 12,
      changePercent: -4.5,
      evidenceCount: 3,
      lastOccurredAt: '2026-07-20T00:00:00.000Z',
      summary: 'fixture',
      actionHint: null,
      runId: 'run-fixture',
      modelVersion: 'fixture',
      analyzedAt: '2026-07-21T00:00:00.000Z',
    };
    const accessibleName = getIssueAccessibleName(issue);
    assert.match(accessibleName, /앱 실행 오류 상세 보기/);
    assert.match(accessibleName, /카테고리 버그 및 성능/);
    assert.match(accessibleName, /심각도 높음/);
    assert.match(accessibleName, /리뷰 12건/);
    assert.match(accessibleName, /변화 4\.5% 감소/);
    assert.match(accessibleName, /근거 리뷰 3건/);
    assert.match(accessibleName, /최근 발생/);

  });

  await test('request polling is limited to visible pages with active jobs and retries are guarded', () => {
    assert.equal(hasActivePipelineJobs([jobFixture('queued')]), true);
    assert.equal(hasActivePipelineJobs([jobFixture('running')]), true);
    assert.equal(hasActivePipelineJobs([jobFixture('completed'), jobFixture('failed')]), false);

    const source = readFileSync('src/routes/RequestsPage.tsx', 'utf8');
    assert.match(source, /document\.visibilityState === 'visible'/);
    assert.match(source, /!hasActiveJobs \|\| !pageVisible/);
    assert.match(source, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === 'visible'\)/);
    assert.match(source, /retryInFlight\.current\.has\(job\.id\)/);
    assert.match(source, /setLoadError\(null\)/);
    assert.match(source, /if \(!token\) \{\s*setLoadError\(REQUEST_HISTORY_SESSION_MESSAGE\);\s*return;/);
    assert.match(source, /isSessionRejected\(error\)\s*\? REQUEST_HISTORY_SESSION_MESSAGE/);
    assert.doesNotMatch(source, /\{job\.error_message\}/);
    assert.match(source, /분석 요청을 완료하지 못했습니다/);
  });

  await test('collection-capacity failures explain the fixed state and disable ineffective retries', () => {
    const genericFailure = jobFixture('failed');
    const capacityFailure = {
      ...jobFixture('failed'),
      failure_code: 'review_scope_incomplete' as const,
    };

    assert.equal(canRetryPipelineJob(genericFailure), true);
    assert.equal(canRetryPipelineJob(capacityFailure), false);
    assert.match(getPipelineJobFailureMessage(capacityFailure), /요청 기간의 리뷰/);
    assert.match(getPipelineJobFailureMessage(capacityFailure), /같은 조건으로 재시도하지 마세요/);
  });

  await test('report requests show the safe daily-limit message without masking uncertain failures', () => {
    const quotaError = new ApiError('최근 24시간 분석 요청 한도를 모두 사용했습니다.', {
      status: 429,
      code: 'job_daily_limit_reached',
      retryable: false,
    });
    const appNotFound = new ApiError('App Store 앱을 확인하지 못했습니다.', {
      status: 400,
      code: 'app_not_found',
      retryable: false,
    });
    const requestRateLimit = new ApiError('요청이 너무 빠르게 반복되었습니다.', {
      status: 429,
      code: 'job_request_rate_limited',
      retryable: false,
    });
    const requestGuardUnavailable = new ApiError('분석 요청 보호 상태를 확인하지 못했습니다.', {
      status: 503,
      code: 'job_request_guard_unavailable',
      retryable: true,
    });
    const fallback = '분석 요청 상태를 확인하지 못했습니다.';
    assert.equal(getAnalysisRequestFailureMessage(quotaError, fallback), quotaError.message);
    assert.equal(getAnalysisRequestFailureMessage(appNotFound, fallback), appNotFound.message);
    assert.equal(getAnalysisRequestFailureMessage(requestRateLimit, fallback), requestRateLimit.message);
    assert.equal(
      getAnalysisRequestFailureMessage(requestGuardUnavailable, fallback),
      requestGuardUnavailable.message,
    );
    assert.equal(getAnalysisRequestFailureMessage(new ApiError('invalid access token', {
      status: 401,
      code: 'unauthorized',
      retryable: false,
    }), fallback), ANALYSIS_REQUEST_SESSION_MESSAGE);
    assert.equal(getAnalysisRequestFailureMessage(new Error('network detail'), fallback), fallback);

  });

  await test('retry requests show the safe daily-limit message without claiming an enqueue result', () => {
    const quotaError = new ApiError('최근 24시간 분석 요청 한도를 모두 사용했습니다.', {
      status: 429,
      code: 'job_daily_limit_reached',
      retryable: false,
    });
    const fallback = '재시도 요청 상태를 확인하지 못했습니다.';
    assert.equal(getAnalysisRequestFailureMessage(quotaError, fallback), quotaError.message);
    assert.equal(getAnalysisRequestFailureMessage(new Error('network detail'), fallback), fallback);

    const source = readFileSync('src/routes/RequestsPage.tsx', 'utf8');
    assert.match(source, /catch \(error\)[\s\S]*?getAnalysisRequestFailureMessage\(\s*error,/);
    assert.match(source, /if \(!token\) \{\s*setActionMessage\(ANALYSIS_REQUEST_SESSION_MESSAGE\);\s*return;/);
  });

  await test('mobile issue titles reserve the absolute severity badge width', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    assert.match(styles, /@media \(max-width: 779px\)[\s\S]*?\.issue-row__name \{[^}]*padding-right: 72px;/);
  });

  await test('user-facing failures do not render provider errors or analysis provenance', () => {
    const loginSource = readFileSync('src/routes/LoginPage.tsx', 'utf8');
    const reportSource = readFileSync('src/routes/AppReportPage.tsx', 'utf8');
    const exploreSource = readFileSync('src/routes/ExplorePage.tsx', 'utf8');

    assert.doesNotMatch(loginSource, /err\.message|error\.message/);
    assert.match(loginSource, /현재 로그인되지 않은 상태입니다/);
    assert.doesNotMatch(reportSource, /detail\.issue\.modelVersion|Run \{/);
    assert.match(reportSource, /공개 데이터는 변경되지 않았습니다/);
    assert.match(exploreSource, /다시 시도/);
  });

  await test('supporting and placeholder text colors meet WCAG AA contrast', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    assert.match(styles, /global-search__form input::placeholder \{ color: #697386/);
    assert.match(styles, /review-search input::placeholder \{ color: #697386/);
    assert.ok(contrastRatio('#697386', '#f9fafb') >= 4.5);
    assert.ok(contrastRatio('#697386', '#ffffff') >= 4.5);
    assert.ok(contrastRatio('#606b7a', '#f0f2f5') >= 4.5);
    assert.match(styles, /\.review-search:focus-within \{ outline: 2px solid #2457d6/);
    assert.match(styles, /@media \(max-width: 779px\)[\s\S]*\.issue-row \{ position: relative; display: grid; grid-template-columns: 1fr auto/);
  });

  await test('compact metadata and controls retain readable and comfortable minimums', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    const requests = readFileSync('src/routes/RequestsPage.tsx', 'utf8');

    assert.match(styles, /body \{[^}]*line-height: 1\.5/);
    assert.match(styles, /\.search-result__copy small \{[^}]*font-size: 12px;[^}]*line-height: 1\.4/);
    assert.match(styles, /\.issue-row__name small \{[^}]*font-size: 12px;[^}]*line-height: 1\.4/);
    assert.match(styles, /\.job-row p \{[^}]*font-size: 12px;[^}]*line-height: 1\.5/);
    assert.match(styles, /\.job-progress small \{[^}]*font-size: 12px;[^}]*line-height: 1\.4/);

    assert.match(styles, /\.login-link \{[^}]*min-height: 44px/);
    assert.match(styles, /\.icon-button \{[^}]*width: 44px; height: 44px/);
    assert.match(styles, /\.account-menu__panel--delete \{[^}]*max-height: calc\(100dvh - 80px\);[^}]*overflow-y: auto/);
    assert.match(styles, /\.account-delete-panel input \{[^}]*height: 44px/);
    assert.match(styles, /\.global-search__form > button \{[^}]*width: 44px; height: 44px/);
    assert.match(styles, /\.refresh-button, \.not-analyzed button \{ min-height: 44px/);
    assert.match(styles, /\.review-search \{[^}]*height: 44px/);
    assert.match(styles, /\.job-row__actions a, \.job-row__actions button \{[^}]*min-height: 44px/);

    assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.job-progress \{ grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);[^}]*overflow: visible/);
    assert.match(styles, /\.job-progress \.is-current small \{ color: #172033; font-weight: 700; \}/);
    assert.match(requests, /aria-current=\{isCurrent \? 'step' : undefined\}/);

    const runningStages = [0, 1, 2, 3, 4].map((index) => getPipelineStagePresentation('running', index, 2));
    assert.deepEqual(runningStages.map(({ isCurrent }) => isCurrent), [false, false, true, false, false]);
    assert.deepEqual(runningStages.map(({ isActive }) => isActive), [true, true, true, false, false]);
    assert.equal(getPipelineStagePresentation('completed', 4, 4).isCurrent, false);
  });
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
