import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import { getMyPipelineJobs, requestAnalysis } from '@/lib/api';
import {
  ANALYSIS_REQUEST_SESSION_MESSAGE,
  getAnalysisRequestFailureMessage,
  isSessionRejected,
} from '@/lib/analysisRequestError';
import { reportPath } from '@/lib/appIdentity';
import { getAccessToken } from '@/lib/auth';
import type { PipelineJobItem } from '@/types';

const stages = ['queued', 'fetching', 'extracting', 'clustering', 'publishing'] as const;
const stageLabel = {
  queued: '대기', fetching: '리뷰 수집', extracting: '리뷰 추출', clustering: '이슈 군집화', publishing: '게시',
} as const;
const REQUEST_POLL_INTERVAL_MS = 10_000;
const REQUEST_HISTORY_SESSION_MESSAGE =
  '로그인 세션을 확인하지 못해 요청 내역을 불러오지 않았습니다. 다시 로그인한 뒤 확인하세요.';

type Props = { loggedIn: boolean; authChecking: boolean };

export function hasActivePipelineJobs(jobs: PipelineJobItem[]) {
  return jobs.some((job) => job.status === 'queued' || job.status === 'running');
}

export function isReviewScopeIncomplete(job: PipelineJobItem) {
  return job.status === 'failed' && job.failure_code === 'review_scope_incomplete';
}

export function canRetryPipelineJob(job: PipelineJobItem) {
  return job.status === 'failed' && !isReviewScopeIncomplete(job);
}

export function getPipelineJobFailureMessage(job: PipelineJobItem) {
  return isReviewScopeIncomplete(job)
    ? '요청 기간의 리뷰가 현재 수집 한도를 초과해 분석을 완료하지 않았습니다. 수집 범위가 확장되기 전에는 같은 조건으로 재시도하지 마세요.'
    : '분석 요청을 완료하지 못했습니다. 잠시 후 다시 시도하세요.';
}

export function getPipelineStagePresentation(status: PipelineJobItem['status'], index: number, activeIndex: number) {
  return {
    isActive: index <= activeIndex,
    isCurrent: index === activeIndex && (status === 'queued' || status === 'running'),
  };
}

export function RequestsPage({ loggedIn, authChecking }: Props) {
  const [jobs, setJobs] = useState<PipelineJobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  const [retryingJobIds, setRetryingJobIds] = useState<Set<string>>(() => new Set());
  const loadInFlight = useRef<Promise<void> | null>(null);
  const retryInFlight = useRef(new Set<string>());

  const load = useCallback(async (showLoading = false) => {
    if (authChecking) return;
    if (!loggedIn) {
      setJobs([]);
      setLoading(false);
      return;
    }
    if (loadInFlight.current) {
      await loadInFlight.current;
      return;
    }

    const request = (async () => {
      if (showLoading) setLoading(true);
      try {
        const token = await getAccessToken();
        if (!token) {
          setLoadError(REQUEST_HISTORY_SESSION_MESSAGE);
          return;
        }
        const response = await getMyPipelineJobs(token, 30);
        setJobs(response.data);
        setLoadError(null);
      } catch (error) {
        setLoadError(
          isSessionRejected(error)
            ? REQUEST_HISTORY_SESSION_MESSAGE
            : '요청 내역을 불러오지 못했습니다. 표시된 상태는 최신이 아닐 수 있습니다. 다시 시도하세요.',
        );
      } finally {
        if (showLoading) setLoading(false);
      }
    })();

    loadInFlight.current = request;
    try {
      await request;
    } finally {
      if (loadInFlight.current === request) loadInFlight.current = null;
    }
  }, [authChecking, loggedIn]);

  useEffect(() => { void load(true); }, [load]);

  useEffect(() => {
    const handleVisibilityChange = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const hasActiveJobs = hasActivePipelineJobs(jobs);
  useEffect(() => {
    if (authChecking || !loggedIn || !hasActiveJobs || !pageVisible) return;

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(false);
    }, REQUEST_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [authChecking, hasActiveJobs, load, loggedIn, pageVisible]);

  const retry = async (job: PipelineJobItem) => {
    if (retryInFlight.current.has(job.id)) return;
    retryInFlight.current.add(job.id);
    setRetryingJobIds((current) => new Set(current).add(job.id));
    setActionMessage(null);

    try {
      const token = await getAccessToken();
      if (!token) {
        setActionMessage(ANALYSIS_REQUEST_SESSION_MESSAGE);
        return;
      }
      const response = await requestAnalysis(token, {
        appStoreId: job.app_store_id,
        country: job.country,
        appName: job.app_name || undefined,
      });
      setActionMessage(
        response.result === 'fresh'
          ? '최근 분석 결과가 이미 있습니다.'
          : response.result === 'existing'
            ? '진행 중인 요청이 이미 있습니다.'
            : '재시도 요청을 등록했습니다.',
      );
      await load(false);
    } catch (error) {
      setActionMessage(getAnalysisRequestFailureMessage(
        error,
        '재시도 요청 상태를 확인하지 못했습니다. 동일 요청이 이미 등록되었을 수 있습니다. 요청 내역을 확인한 뒤 다시 시도하세요.',
      ));
    } finally {
      retryInFlight.current.delete(job.id);
      setRetryingJobIds((current) => {
        const next = new Set(current);
        next.delete(job.id);
        return next;
      });
    }
  };

  if (authChecking) return <div className="request-loading" role="status"><LoaderCircle className="is-spinning" /> 로그인 상태 확인 중</div>;
  if (!loggedIn) return <div className="auth-gate"><h1>분석 요청 내역</h1><p>로그인이 필요합니다.</p><Link to="/login?returnTo=%2Frequests">로그인 <ArrowRight /></Link></div>;

  return <div className="requests-page">
    <header className="page-title"><h1>분석 요청 내역</h1></header>
    {actionMessage ? <div className="request-banner" role="status">{actionMessage}</div> : null}
    {loadError ? <div className="request-banner request-banner--error" role="alert">
      <span>{loadError}</span>
      <button type="button" onClick={() => void load(false)}>다시 시도</button>
    </div> : null}
    {loading ? <div className="request-loading"><LoaderCircle className="is-spinning" /> 요청 내역 불러오는 중</div> : jobs.length ? <div className="job-list">
      {jobs.map((job) => {
        const stage = job.stage || (job.status === 'queued' ? 'queued' : null);
        const activeIndex = stage ? stages.indexOf(stage) : job.status === 'completed' ? stages.length : -1;
        const retrying = retryingJobIds.has(job.id);
        return <article key={job.id} className="job-row">
          <div className="job-row__top">
            <div className="app-initial">{job.app_name?.[0] || 'A'}</div>
            <div><h2>{job.app_name || `App ${job.app_store_id}`}</h2><p>{job.app_store_id} · {job.country.toUpperCase()} · {new Date(job.requested_at).toLocaleString('ko-KR')}</p></div>
            <span className={`job-status job-status--${job.status}`}>{job.status === 'completed' ? '완료' : job.status === 'failed' ? '실패' : job.status === 'canceled' ? '취소' : '진행 중'}</span>
          </div>
          <div className="job-progress" aria-label={`현재 단계 ${stage ? stageLabel[stage] : job.status}`}>
            {stages.map((item, index) => {
              const { isActive, isCurrent } = getPipelineStagePresentation(job.status, index, activeIndex);
              const className = `${isActive ? 'is-active' : ''}${isCurrent ? ' is-current' : ''}`.trim();
              return <div key={item} className={className} aria-current={isCurrent ? 'step' : undefined}>
                <span>{index < activeIndex || job.status === 'completed' ? <Check /> : index === activeIndex ? <LoaderCircle className={job.status === 'running' ? 'is-spinning' : ''} /> : index + 1}</span>
                <small>{stageLabel[item]}</small>
              </div>;
            })}
          </div>
          {job.status === 'failed' ? <p className="job-error"><AlertTriangle />{getPipelineJobFailureMessage(job)}</p> : null}
          <div className="job-row__actions">
            {job.status === 'completed' ? <Link to={reportPath(job.app_store_id, job.country)}>완료 리포트 <ArrowRight /></Link> : null}
            {canRetryPipelineJob(job) ? <button
              type="button"
              disabled={retrying}
              aria-busy={retrying}
              onClick={() => void retry(job)}
            >
              <RefreshCw className={retrying ? 'is-spinning' : ''} /> {retrying ? '등록 중…' : '재시도'}
            </button> : null}
          </div>
        </article>;
      })}
    </div> : <div className="quiet-empty">요청 내역이 없습니다.</div>}
  </div>;
}
