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
import { ApiError, deleteAccount, getIssueDetail, getPublicReport, getPublicReviews } from '@/lib/api';
import { createRecentReviewWindow, getIssueAccessibleName, mergeReviewItems } from '@/routes/AppReportPage';
import {
  canRetryPipelineJob,
  getPipelineJobFailureMessage,
  hasActivePipelineJobs,
} from '@/routes/RequestsPage';
import type { DiscoveryItem, IssueClusterItem, PipelineJobItem, ReviewItem } from '@/types';

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

    const source = readFileSync('src/components/GlobalSearch.tsx', 'utf8');
    assert.match(source, /requestSequence/);
    assert.match(source, /onChange=\{\(event\) => \{\s*requestSequence\.current \+= 1/);
    assert.match(source, /aria-activedescendant/);
    assert.match(source, /ArrowDown/);
    assert.match(source, /ArrowUp/);
    assert.match(source, /Escape/);
  });

  await test('review pagination deduplicates cursor overlap and exposes debounce and recovery controls', () => {
    const first = reviewFixture('review-1', 'first');
    const overlapping = reviewFixture('review-1', 'new duplicate');
    const second = reviewFixture('review-2', 'second');
    assert.deepEqual(mergeReviewItems([first], [overlapping, second]), [first, second]);

    const source = readFileSync('src/routes/AppReportPage.tsx', 'utf8');
    assert.match(source, /useDebouncedValue\(query\.trim\(\), queryRevision, 350\)/);
    assert.match(source, /cursor: nextCursor/);
    assert.match(source, /onChange=\{\(event\) => \{\s*requestSequence\.current \+= 1;\s*loadMoreInFlight\.current = null;\s*setLoadingMore\(false\);\s*setItems\(\[\]\);\s*setNextCursor\(null\);\s*setHasNext\(false\)/);
    assert.match(source, /setQueryRevision\(\(value\) => value \+ 1\)/);
    assert.match(source, /setError\(null\)/);
    assert.match(source, /리뷰 더 보기/);
    assert.match(source, /기존 리뷰는 그대로 유지됩니다/);
  });

  await test('report, issue detail, and review requests share one explicit 30-day window', async () => {
    const window = createRecentReviewWindow(new Date('2026-07-29T08:00:59.999Z'));
    assert.deepEqual(window, {
      from: '2026-06-30T00:00:00.000Z',
      to: '2026-07-29T23:59:59.999Z',
    });
    assert.deepEqual(
      createRecentReviewWindow(new Date('2026-07-29T23:59:59.999Z')),
      window,
    );
    assert.deepEqual(createRecentReviewWindow(new Date('2026-07-30T00:00:00.000Z')), {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-30T23:59:59.999Z',
    });

    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return Response.json({ data: [], page: 1, limit: 50, hasNext: false, nextCursor: null });
    }) as typeof fetch;

    try {
      await getPublicReport('123456789', 'kr', window.from, window.to);
      await getIssueDetail('11111111-1111-4111-8111-111111111111', window.from, window.to);
      await getPublicReviews('123456789', {
        country: 'kr',
        from: window.from,
        to: window.to,
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
    assert.equal(reportUrl.searchParams.get('from'), window.from);
    assert.equal(reportUrl.searchParams.get('to'), window.to);
    assert.equal(issueDetailUrl.searchParams.get('from'), window.from);
    assert.equal(issueDetailUrl.searchParams.get('to'), window.to);
    assert.equal(scopedReviewsUrl.searchParams.get('from'), window.from);
    assert.equal(scopedReviewsUrl.searchParams.get('to'), window.to);
    assert.equal(scopedReviewsUrl.searchParams.get('searchScope'), 'content');
    assert.equal(compatibleReviewsUrl.searchParams.has('from'), false);
    assert.equal(compatibleReviewsUrl.searchParams.has('to'), false);
    assert.equal(compatibleReviewsUrl.searchParams.has('searchScope'), false);
  });

  await test('report route state is app-scoped and issue rows expose every meaningful cell', () => {
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

    const source = readFileSync('src/routes/AppReportPage.tsx', 'utf8');
    assert.match(source, /<AppReportPageContent key=\{appScope\}/);
    assert.match(source, /if \(activeTab !== 'issues'\) setSelectedIssue\(null\)/);
    assert.match(source, /getIssueDetail\(issue\.issueId, from, to\)/);
    assert.match(source, /<IssuePanel[\s\S]*?from=\{reportWindow\.from\}[\s\S]*?to=\{reportWindow\.to\}/);
    assert.match(source, /detail\.reviews\.length < detail\.issue\.evidenceCount/);
    assert.match(source, /<span>\{report\.summary\.issueCount\}<\/span>/);
    assert.match(source, /전체 \{totalCount\.toLocaleString\(\)\}건 중 \{issues\.length\.toLocaleString\(\)\}건을 표시합니다/);
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

    const source = readFileSync('src/routes/AppReportPage.tsx', 'utf8');
    assert.match(source, /catch \(error\)[\s\S]*?getAnalysisRequestFailureMessage\(\s*error,/);
    assert.match(source, /if \(!token\) \{\s*setRequestMessage\(ANALYSIS_REQUEST_SESSION_MESSAGE\);\s*return;/);
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
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
