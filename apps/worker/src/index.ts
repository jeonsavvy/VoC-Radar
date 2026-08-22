import type { Env } from './types';
import { UpstreamRequestError, boolFromEnv, errorResponse, jsonResponse, runSupabaseKeepalive, withCors } from './platform';
import { routePublicRequest } from './public';
import { routePrivateRequest } from './private';
import { routeInternalRequest } from './internal';

const SPA_PATHS = new Set(['/', '/login', '/privacy', '/requests', '/reset-password']);
const APP_REPORT_PATH = /^\/apps\/[a-z]{2}\/\d{5,20}(?:\/(?:overview|issues|reviews))?$/;

function isApiPath(pathname: string) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function isSpaPath(pathname: string) {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return SPA_PATHS.has(normalized) || APP_REPORT_PATH.test(normalized);
}

function acceptsMarkdown(request: Request) {
  return (request.headers.get('accept') || '').split(',').some((range) => {
    const [mediaType, ...parameters] = range.trim().toLowerCase().split(';');
    if (mediaType !== 'text/markdown') return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
    return quality === undefined || Number(quality.split('=', 2)[1]) > 0;
  });
}

function addDocumentVary(headers: Headers) {
  const values = (headers.get('vary') || '').split(',').map((value) => value.trim()).filter(Boolean);
  for (const required of ['Accept', 'Accept-Encoding']) {
    if (!values.some((value) => value.toLowerCase() === required.toLowerCase())) values.push(required);
  }
  headers.set('vary', values.join(', '));
}

function withDocumentVary(response: Response, contentType?: string) {
  const headers = new Headers(response.headers);
  addDocumentVary(headers);
  if (contentType) headers.set('content-type', contentType);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function siteErrorResponse(request: Request, status: 404 | 405) {
  const url = new URL(request.url);
  const isHead = request.method === 'HEAD';
  const body = status === 404
    ? [
        '# 404 — 요청한 경로를 찾을 수 없습니다.',
        '',
        'VoC Radar의 공개 리소스에서 다음 경로를 확인하세요.',
        '',
        `- [사이트맵](${url.origin}/sitemap.xml)`,
        `- [에이전트 안내](${url.origin}/llms.txt)`,
        `- [공개 API 명세](${url.origin}/openapi.json)`,
      ].join('\n')
    : '# 405 — 이 경로는 GET과 HEAD 요청만 지원합니다.\n';
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-language': 'ko',
    'content-type': 'text/markdown; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  if (status === 405) headers.set('allow', 'GET, HEAD');
  return new Response(isHead ? null : body, { status, headers });
}

async function routeSiteRequest(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (isApiPath(url.pathname)) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return siteErrorResponse(request, 405);
  if (!env.ASSETS) {
    return new Response('Static assets are unavailable.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (url.pathname === '/' && acceptsMarkdown(request)) {
    const guideUrl = new URL('/llms.txt', url);
    const guide = await env.ASSETS.fetch(new Request(guideUrl, request));
    return withDocumentVary(guide, 'text/markdown; charset=utf-8');
  }

  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 404) {
    return url.pathname === '/' ? withDocumentVary(asset) : asset;
  }

  if (isSpaPath(url.pathname)) {
    // Cloudflare canonicalizes /index.html to / with a redirect. Fetching the
    // root asset internally keeps the browser's deep-link URL intact.
    const indexUrl = new URL('/', url);
    return env.ASSETS.fetch(new Request(indexUrl, request));
  }

  return siteErrorResponse(request, 404);
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runSupabaseKeepalive(env)
        .then(() => {
          console.log(JSON.stringify({
            event: 'keepalive_completed',
            status: 'success',
            scheduledAt: new Date(controller.scheduledTime).toISOString(),
          }));
        })
        .catch((error) => {
          console.error(JSON.stringify({
            event: 'keepalive_completed',
            status: 'failed',
            retryable: error instanceof UpstreamRequestError ? error.status >= 500 || error.status === 429 : true,
            scheduledAt: new Date(controller.scheduledTime).toISOString(),
          }));
          throw error;
        }),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return withCors(env, new Response(null, { status: 204 }));

    const siteResponse = await routeSiteRequest(env, request);
    if (siteResponse) return siteResponse;

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
      return errorResponse(env, 500, 'service_unavailable', '요청을 처리할 준비가 되지 않았습니다. 잠시 후 다시 시도해 주세요.', true, requestId);
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return jsonResponse(env, 200, {
          ok: true,
          detailViewEnabled: boolFromEnv(env.DETAIL_VIEW_ENABLED, true),
          reportV2Enabled: boolFromEnv(env.REPORT_V2_ENABLED, false),
          timestamp: new Date().toISOString(),
        });
      }

      for (const route of [routePublicRequest, routePrivateRequest, routeInternalRequest]) {
        const response = await route(env, request);
        if (response) return response;
      }
      return errorResponse(env, 404, 'not_found', '요청한 API 경로를 찾을 수 없습니다.', false, requestId);
    } catch (error) {
      const upstream = error instanceof UpstreamRequestError ? error : null;
      const retryable = upstream ? upstream.status === 429 || upstream.status >= 500 : false;
      const status = upstream ? 502 : 500;
      const code = upstream ? 'upstream_unavailable' : 'internal_error';
      console.error(JSON.stringify({ event: 'request_failed', requestId, method: request.method, path: url.pathname, status, error: code, retryable }));
      return errorResponse(
        env, status, code,
        retryable
          ? '외부 서비스 응답을 완료하지 못했습니다. 현재 상태는 변경되지 않았을 수 있습니다. 잠시 후 다시 시도해 주세요.'
          : '요청을 완료하지 못했습니다. 현재 상태를 확인한 뒤 다시 시도해 주세요.',
        retryable, requestId,
      );
    }
  },
};
