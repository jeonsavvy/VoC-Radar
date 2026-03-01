import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createPipelineJob, getMyPipelineJobs, getPublicApps } from '../lib/api';
import { getAccessToken } from '../lib/auth';
import { isValidAppId, normalizeCountry, type AppSelection } from '../lib/appSelection';
import type { PipelineJobItem, PublicAppItem } from '../types';

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
  const [appName, setAppName] = useState('');
  const [appStoreUrl, setAppStoreUrl] = useState('');
  const [note, setNote] = useState('');

  const [apps, setApps] = useState<PublicAppItem[]>([]);
  const [jobs, setJobs] = useState<PipelineJobItem[]>([]);

  const [loadingApps, setLoadingApps] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAppId(selection.appId);
    setCountry(selection.country);
  }, [selection.appId, selection.country]);

  useEffect(() => {
    let mounted = true;

    setLoadingApps(true);
    getPublicApps(30)
      .then((response) => {
        if (!mounted) {
          return;
        }
        setApps(response.data);
      })
      .catch((err) => {
        if (!mounted) {
          return;
        }
        setError(err instanceof Error ? err.message : '앱 목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (mounted) {
          setLoadingApps(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

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

      const response = await getMyPipelineJobs(token, 20);
      setJobs(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '분석 요청 이력을 불러오지 못했습니다.');
    } finally {
      setLoadingJobs(false);
    }
  };

  useEffect(() => {
    loadJobs();
  }, [loggedIn]);

  const knownApps = useMemo(() => {
    const map = new Map<string, PublicAppItem>();

    for (const item of apps) {
      const key = `${item.app_store_id}:${item.country}`;
      if (!map.has(key)) {
        map.set(key, item);
      }
    }

    return [...map.values()];
  }, [apps]);

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
      setMessage('앱 선택은 반영되었습니다. 분석 요청은 로그인 후 가능합니다.');
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
        appName: appName.trim() || undefined,
        note: note.trim() || undefined,
      });

      setMessage(`요청 등록 완료: ${response.data.id}`);
      setNote('');
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '분석 요청 등록에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const onExtractFromUrl = () => {
    const idMatch = appStoreUrl.match(/id(\d{5,20})/i);
    if (!idMatch?.[1]) {
      setError('앱스토어 URL에서 App ID를 찾지 못했습니다. 예: https://apps.apple.com/kr/app/.../id1018769995');
      return;
    }
    setError(null);
    setAppId(idMatch[1]);
  };

  return (
    <section className="panel" aria-labelledby="analyze-heading">
      <h2 id="analyze-heading">분석 요청</h2>
      <p className="muted">
        앱 ID/국가를 입력하면 요청이 큐에 쌓이고, n8n 파이프라인이 최근 리뷰 최대 <strong>500개</strong>까지 수집/분석합니다.
      </p>

      <div className="helper-panel">
        <h3>App ID 찾는 법</h3>
        <ul className="bullet-list">
          <li>앱스토어 상세 URL의 <code>id숫자</code>가 App Store ID입니다.</li>
          <li>예시: <code>.../id1018769995</code> → <code>1018769995</code></li>
          <li>아래에 앱스토어 URL을 붙여넣고 ID 자동 추출도 가능합니다.</li>
        </ul>
        <div className="inline-form compact-form">
          <label htmlFor="app-store-url">앱스토어 URL</label>
          <input
            id="app-store-url"
            value={appStoreUrl}
            onChange={(event) => setAppStoreUrl(event.target.value)}
            placeholder="https://apps.apple.com/kr/app/.../id1018769995"
          />
          <button type="button" className="ghost-button" onClick={onExtractFromUrl}>
            URL에서 ID 추출
          </button>
        </div>
      </div>

      <form onSubmit={onSubmit} className="inline-form">
        <label htmlFor="app-id">App Store ID</label>
        <input
          id="app-id"
          value={appId}
          onChange={(event) => setAppId(event.target.value)}
          placeholder="예: 1018769995"
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

        <label htmlFor="app-name">앱 이름 (선택)</label>
        <input
          id="app-name"
          value={appName}
          onChange={(event) => setAppName(event.target.value)}
          placeholder="Daangn"
        />

        <label htmlFor="note">요청 메모 (선택)</label>
        <input
          id="note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="버전 출시 후 반응 확인"
        />

        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? '요청 등록 중...' : loggedIn ? '분석 요청 등록' : '앱 선택 적용'}
        </button>
      </form>

      {!loggedIn && (
        <p className="muted">
          분석 요청 등록은 <Link to="/login">로그인</Link> 후 가능합니다.
        </p>
      )}

      {message && <p>{message}</p>}
      {error && <p className="error">{error}</p>}

      <hr className="divider" />

      <h3>최근 앱 목록</h3>
      {loadingApps && <p>앱 목록 로딩 중...</p>}
      {!loadingApps && knownApps.length > 0 && (
        <div className="chip-list">
          {knownApps.map((item) => (
            <button
              key={`${item.app_store_id}:${item.country}`}
              type="button"
              className="chip-button"
              onClick={() => {
                setAppId(item.app_store_id);
                setCountry(item.country);
                setAppName(item.app_name || '');
              }}
            >
              {(item.app_name || 'Unknown App').trim()} · {item.app_store_id} · {item.country}
            </button>
          ))}
        </div>
      )}

      <h3>내 요청 이력</h3>
      {loadingJobs && <p>요청 이력 로딩 중...</p>}
      {!loadingJobs && jobs.length === 0 && <p className="muted">아직 등록된 요청이 없습니다.</p>}

      {jobs.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">요청 시각</th>
                <th scope="col">앱</th>
                <th scope="col">상태</th>
                <th scope="col">runId</th>
                <th scope="col">에러</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{new Date(job.requested_at).toLocaleString()}</td>
                  <td>
                    {(job.app_name || 'Unknown App').trim()} ({job.app_store_id}/{job.country})
                  </td>
                  <td>{statusLabel[job.status]}</td>
                  <td>{job.run_id || '-'}</td>
                  <td>{job.error_message || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
