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
import { ApiError, deleteAccount, getPublicReport } from '@/lib/api';
import { mergeReviewItems } from '@/routes/AppReportPage';
import { hasActivePipelineJobs } from '@/routes/RequestsPage';
import type { DiscoveryItem, PipelineJobItem, ReviewItem } from '@/types';

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
    assert.match(notStarted, /계정과 진행 중인 분석 요청은 그대로 유지/);
    assert.match(notStarted, /작업 취소는 시작되지 않았습니다/);
    assert.match(notStarted, /다시 시도하세요/);
    assert.match(incomplete, /계정은 유지됩니다/);
    assert.match(incomplete, /분석 요청은 취소되었습니다/);

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
    assert.doesNotMatch(source, /\{job\.error_message\}/);
    assert.match(source, /분석 요청을 완료하지 못했습니다/);
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
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
