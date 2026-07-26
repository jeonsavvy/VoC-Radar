import type { Env } from './types';
import { UpstreamRequestError, boolFromEnv, errorResponse, jsonResponse, runSupabaseKeepalive, withCors } from './platform';
import { routePublicRequest } from './public';
import { routePrivateRequest } from './private';
import { routeInternalRequest } from './internal';

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
