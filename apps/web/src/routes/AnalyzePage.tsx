import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createPipelineJob, getMyPipelineJobs } from '../lib/api';
import { getAccessToken } from '../lib/auth';
import { isValidAppId, normalizeCountry, type AppSelection } from '../lib/appSelection';
import type { PipelineJobItem } from '../types';

type Props = {
  loggedIn: boolean;
  selection: AppSelection;
  onSelectionChange: (next: AppSelection) => void;
};

const statusLabel: Record<PipelineJobItem['status'], string> = {
  queued: '대기',
  running: '실행 중',
  completed: '완료',
  failed: '실패',
  canceled: '취소',
};

export function AnalyzePage({ loggedIn, selection, onSelectionChange }: Props) {
  const [appId, setAppId] = useState(selection.appId);
  const [country, setCountry] = useState(selection.country);
  const [jobs, setJobs] = useState<PipelineJobItem[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAppId(selection.appId);
    setCountry(selection.country);
  }, [selection.appId, selection.country]);

  const loadJobs = async () => {
    if (!loggedIn) {
      setJobs([]);
      return;
    }

    setLoadingJobs(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('로그인 세션이 만료되었습니다. 다시 로그인하세요.');
      }
      const response = await getMyPipelineJobs(token, 10);
      setJobs(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청 이력을 불러오지 못했습니다.');
    } finally {
      setLoadingJobs(false);
    }
  };

  useEffect(() => {
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    const normalizedAppId = appId.trim();
    if (!isValidAppId(normalizedAppId)) {
      setError('App Store ID는 숫자 5~20자리여야 합니다.');
      return;
    }

    const normalizedCountry = normalizeCountry(country);
    onSelectionChange({
      appId: normalizedAppId,
      country: normalizedCountry,
    });

    if (!loggedIn) {
      setMessage('앱 선택만 반영되었습니다. 실제 요청 등록은 로그인 후 가능합니다.');
      return;
    }

    setSubmitting(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('로그인 세션이 만료되었습니다. 다시 로그인하세요.');
      }

      const response = await createPipelineJob(token, {
        appStoreId: normalizedAppId,
        country: normalizedCountry,
      });

      setMessage(`요청 등록 완료: ${response.data.id}`);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청 등록에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="analyze-heading">
      <h2 id="analyze-heading">수집/분석 실행 요청</h2>
      <p className="muted">
        여기서 요청을 등록하면 queue에 저장됩니다. n8n 워크플로우가 <strong>켜져 있고 Active 상태</strong>면 스케줄마다
        대기 요청을 자동 처리하고, 꺼져 있으면 요청은 대기 상태로 남습니다.
      </p>

      <form onSubmit={onSubmit} className="inline-form simple-request-form">
        <label htmlFor="app-id">App Store ID</label>
        <input
          id="app-id"
          value={appId}
          onChange={(event) => setAppId(event.target.value)}
          placeholder="예: 625257520"
          required
        />

        <label htmlFor="country">Country</label>
        <input
          id="country"
          value={country}
          onChange={(event) => setCountry(event.target.value)}
          placeholder="kr"
          maxLength={2}
          required
        />

        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? '요청 등록 중...' : loggedIn ? '요청 등록' : '앱 선택 적용'}
        </button>
      </form>

      {!loggedIn && (
        <p className="muted">
          요청 등록은 <Link to="/login">로그인</Link> 후 가능합니다.
        </p>
      )}

      {message && <p>{message}</p>}
      {error && <p className="error">{error}</p>}

      <hr className="divider" />

      <h3>최근 요청 상태</h3>
      {loadingJobs && <p>불러오는 중...</p>}
      {!loadingJobs && jobs.length === 0 && <p className="muted">요청 이력이 없습니다.</p>}
      {jobs.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">요청 시각</th>
                <th scope="col">앱 ID</th>
                <th scope="col">상태</th>
                <th scope="col">runId</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{new Date(job.requested_at).toLocaleString()}</td>
                  <td>
                    {job.app_store_id}/{job.country}
                  </td>
                  <td>{statusLabel[job.status]}</td>
                  <td>{job.run_id || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
