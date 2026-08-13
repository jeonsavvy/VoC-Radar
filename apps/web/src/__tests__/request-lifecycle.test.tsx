import assert from 'node:assert/strict';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import type { DiscoveryItem, ReviewItem } from '@/types';

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const discoveryItem = (appStoreId: string, appName: string): DiscoveryItem => ({
  appStoreId,
  country: 'kr',
  appName,
  artworkUrl: null,
  bundleId: null,
  developerName: 'Fixture Developer',
  analyzed: true,
  lastAnalyzedAt: null,
  source: 'catalog',
});

const reviewItem = (reviewId: string, content: string): ReviewItem => ({
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

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const keys = [
    'window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement',
    'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver',
  ] as const;
  const originalDescriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://voc-radar.example/' });
  const browserWindow = dom.window;
  for (const key of keys) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? browserWindow : browserWindow[key],
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });

  const setInputValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(browserWindow.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new browserWindow.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new browserWindow.Event('change', { bubbles: true }));
  };

  try {
    const { createRoot } = await import('react-dom/client');
    const { MemoryRouter, Route, Routes } = await import('react-router');
    const { AppArtwork } = await import('@/components/AppArtwork');
    const { GlobalSearch } = await import('@/components/GlobalSearch');
    const { ReviewsView } = await import('@/routes/AppReportPage');

    await test('GlobalSearch aborts stale fetches, ignores late results, and preserves keyboard navigation', async () => {
      const originalFetch = globalThis.fetch;
      const pending: Array<{
        url: string;
        signal: AbortSignal;
        resolve: (response: Response) => void;
      }> = [];
      globalThis.fetch = ((input, init) => new Promise<Response>((resolve) => {
        pending.push({ url: String(input), signal: init?.signal as AbortSignal, resolve });
      })) as typeof fetch;
      const container = browserWindow.document.createElement('div');
      browserWindow.document.body.append(container);
      const root = createRoot(container);

      try {
        await act(async () => root.render(
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<GlobalSearch />} />
              <Route path="/apps/:country/:appId/:tab" element={<p>navigated</p>} />
            </Routes>
          </MemoryRouter>,
        ));
        const input = container.querySelector('input') as HTMLInputElement;
        await act(async () => setInputValue(input, 'first'));
        await act(async () => wait(275));
        assert.equal(pending.length, 1);

        await act(async () => setInputValue(input, 'second'));
        assert.equal(pending[0]?.signal.aborted, true);
        await act(async () => wait(275));
        assert.equal(pending.length, 2);

        await act(async () => {
          pending[1]?.resolve(Response.json({ data: [discoveryItem('222222222', 'Second App')] }));
          await wait(0);
        });
        await act(async () => {
          pending[0]?.resolve(Response.json({ data: [discoveryItem('111111111', 'Stale App')] }));
          await wait(0);
        });
        assert.match(container.textContent || '', /Second App/);
        assert.doesNotMatch(container.textContent || '', /Stale App/);

        await act(async () => input.dispatchEvent(new browserWindow.KeyboardEvent('keydown', {
          key: 'ArrowDown', bubbles: true,
        })));
        assert.ok(input.getAttribute('aria-activedescendant'));
        await act(async () => input.dispatchEvent(new browserWindow.KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true,
        })));
        assert.match(container.textContent || '', /navigated/);
      } finally {
        await act(async () => root.unmount());
        container.remove();
        globalThis.fetch = originalFetch;
      }
    });

    await test('ReviewsView keeps cursor pagination behavior and deduplicates overlap', async () => {
      const originalFetch = globalThis.fetch;
      const urls: string[] = [];
      globalThis.fetch = (async (input) => {
        urls.push(String(input));
        return urls.length === 1
          ? Response.json({ data: [reviewItem('review-1', 'first')], page: 1, limit: 50, hasNext: true, nextCursor: 'cursor-1' })
          : Response.json({ data: [reviewItem('review-1', 'duplicate'), reviewItem('review-2', 'second')], page: 1, limit: 50, hasNext: false, nextCursor: null });
      }) as typeof fetch;
      const container = browserWindow.document.createElement('div');
      browserWindow.document.body.append(container);
      const root = createRoot(container);

      try {
        await act(async () => {
          root.render(<ReviewsView
            appId="123456789"
            country="kr"
            from="2026-07-01T00:00:00.000Z"
            to="2026-07-30T23:59:59.999Z"
          />);
          await wait(0);
        });
        const loadMore = [...container.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('리뷰 더 보기'));
        assert.ok(loadMore);
        await act(async () => {
          loadMore.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true }));
          await wait(0);
        });
        assert.equal(new URL(urls[1]!, 'https://example.test').searchParams.get('cursor'), 'cursor-1');
        assert.equal(container.querySelectorAll('.public-review-list article').length, 2);
        assert.match(container.textContent || '', /first/);
        assert.match(container.textContent || '', /second/);
        assert.doesNotMatch(container.textContent || '', /duplicate/);
      } finally {
        await act(async () => root.unmount());
        container.remove();
        globalThis.fetch = originalFetch;
      }
    });

    await test('ReviewsView aborts an in-flight pagination request when it unmounts', async () => {
      const originalFetch = globalThis.fetch;
      let paginationSignal: AbortSignal | undefined;
      let fetchCount = 0;
      globalThis.fetch = ((input, init) => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return Promise.resolve(Response.json({
            data: [reviewItem('review-1', 'first')],
            page: 1,
            limit: 50,
            hasNext: true,
            nextCursor: 'cursor-1',
          }));
        }
        paginationSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }) as typeof fetch;
      const container = browserWindow.document.createElement('div');
      browserWindow.document.body.append(container);
      const root = createRoot(container);
      let rootUnmounted = false;

      try {
        await act(async () => {
          root.render(<ReviewsView
            appId="123456789"
            country="kr"
            from="2026-07-01T00:00:00.000Z"
            to="2026-07-30T23:59:59.999Z"
          />);
          await wait(0);
        });
        const loadMore = [...container.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('리뷰 더 보기'));
        assert.ok(loadMore);
        await act(async () => {
          loadMore.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true }));
          await wait(0);
        });
        assert.equal(paginationSignal?.aborted, false);

        await act(async () => root.unmount());
        rootUnmounted = true;
        assert.equal(paginationSignal?.aborted, true);
      } finally {
        if (!rootUnmounted) {
          await act(async () => root.unmount());
        }
        container.remove();
        globalThis.fetch = originalFetch;
      }
    });

    await test('AppArtwork uses direct URL, one canonical proxy, then the local fallback', async () => {
      const container = browserWindow.document.createElement('div');
      browserWindow.document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => root.render(<AppArtwork
          artworkUrl="https://example.test/direct.jpg"
          appName="Fixture App"
          appStoreId="123456789"
          country="kr"
        />));
        const direct = container.querySelector('img') as HTMLImageElement;
        assert.equal(direct.getAttribute('src'), 'https://example.test/direct.jpg');

        await act(async () => direct.dispatchEvent(new browserWindow.Event('error', { bubbles: false })));
        const proxy = container.querySelector('img') as HTMLImageElement;
        const proxyUrl = new URL(proxy.getAttribute('src') || '', 'https://example.test');
        assert.equal(proxyUrl.pathname, '/api/public/artwork');
        assert.equal(proxyUrl.searchParams.get('appId'), '123456789');
        assert.equal(proxyUrl.searchParams.has('attempt'), false);

        await act(async () => proxy.dispatchEvent(new browserWindow.Event('error', { bubbles: false })));
        assert.equal(container.querySelector('img'), null);
        assert.equal(container.querySelector('.app-initial')?.textContent, 'F');
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  } finally {
    dom.window.close();
    for (const key of keys) {
      const descriptor = originalDescriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    if (originalActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
    else delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
