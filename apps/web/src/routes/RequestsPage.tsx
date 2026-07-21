import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getMyPipelineJobs, requestAnalysis } from '@/lib/api';
import { reportPath } from '@/lib/appIdentity';
import { getAccessToken } from '@/lib/auth';
import type { PipelineJobItem } from '@/types';

const stages = ['queued', 'fetching', 'extracting', 'clustering', 'publishing'] as const;
const stageLabel = {
  queued: '대기', fetching: '리뷰 수집', extracting: '리뷰 추출', clustering: '이슈 군집화', publishing: '게시',
} as const;

type Props = { loggedIn: boolean };

export function RequestsPage({ loggedIn }: Props) {
  const [jobs, setJobs] = useState<PipelineJobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!loggedIn) { setLoading(false); return; }
    setLoading(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('로그인이 필요합니다.');
      const response = await getMyPipelineJobs(token, 30);
      setJobs(response.data);
    } catch (err) { setMessage(err instanceof Error ? err.message : '요청 내역을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [loggedIn]);

  useEffect(() => { void load(); }, [load]);

  const retry = async (job: PipelineJobItem) => {
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('로그인이 필요합니다.');
      const response = await requestAnalysis(token, { appStoreId: job.app_store_id, country: job.country, appName: job.app_name || undefined });
      setMessage(response.result === 'fresh' ? '최근 분석 결과가 이미 있습니다.' : response.result === 'existing' ? '진행 중인 요청이 이미 있습니다.' : '재시도 요청을 등록했습니다.');
      await load();
    } catch (err) { setMessage(err instanceof Error ? err.message : '재시도에 실패했습니다.'); }
  };

  if (!loggedIn) return <div className="auth-gate"><h1>분석 요청 내역</h1><p>로그인이 필요합니다.</p><Link to="/login?returnTo=%2Frequests">로그인 <ArrowRight /></Link></div>;

  return <div className="requests-page">
    <header className="page-title"><h1>분석 요청 내역</h1></header>
    {message ? <div className="request-banner" role="status">{message}</div> : null}
    {loading ? <div className="request-loading"><LoaderCircle className="is-spinning" /> 요청 내역 불러오는 중</div> : jobs.length ? <div className="job-list">
      {jobs.map((job) => {
        const stage = job.stage || (job.status === 'queued' ? 'queued' : null);
        const activeIndex = stage ? stages.indexOf(stage) : job.status === 'completed' ? stages.length : -1;
        return <article key={job.id} className="job-row">
          <div className="job-row__top">
            <div className="app-initial">{job.app_name?.[0] || 'A'}</div>
            <div><h2>{job.app_name || `App ${job.app_store_id}`}</h2><p>{job.app_store_id} · {job.country.toUpperCase()} · {new Date(job.requested_at).toLocaleString('ko-KR')}</p></div>
            <span className={`job-status job-status--${job.status}`}>{job.status === 'completed' ? '완료' : job.status === 'failed' ? '실패' : job.status === 'canceled' ? '취소' : '진행 중'}</span>
          </div>
          <div className="job-progress" aria-label={`현재 단계 ${stage ? stageLabel[stage] : job.status}`}>
            {stages.map((item, index) => <div key={item} className={index <= activeIndex ? 'is-active' : ''}>
              <span>{index < activeIndex || job.status === 'completed' ? <Check /> : index === activeIndex ? <LoaderCircle className={job.status === 'running' ? 'is-spinning' : ''} /> : index + 1}</span>
              <small>{stageLabel[item]}</small>
            </div>)}
          </div>
          {job.error_message ? <p className="job-error"><AlertTriangle />{job.error_message}</p> : null}
          <div className="job-row__actions">
            {job.status === 'completed' ? <Link to={reportPath(job.app_store_id, job.country)}>완료 리포트 <ArrowRight /></Link> : null}
            {job.status === 'failed' ? <button type="button" onClick={() => retry(job)}><RefreshCw /> 재시도</button> : null}
          </div>
        </article>;
      })}
    </div> : <div className="quiet-empty">요청 내역이 없습니다.</div>}

  </div>;
}
