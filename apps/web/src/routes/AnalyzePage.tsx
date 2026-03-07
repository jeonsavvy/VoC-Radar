import { FormEvent, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Play, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AppSearchPicker } from '@/components/app-search-picker';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cancelPipelineJobs, createPipelineJob, getMyPipelineJobs, getPublicAppMeta } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import type { AppSelection } from '@/lib/appSelection';
import type { PipelineJobItem } from '@/types';

type Props = {
  loggedIn: boolean;
  selection: AppSelection;
  onSelectionChange: (next: AppSelection) => void;
};

const STATUS_BADGE: Record<PipelineJobItem['status'], 'secondary' | 'warning' | 'success' | 'destructive' | 'outline'> = {
  queued: 'secondary',
  running: 'warning',
  completed: 'success',
  failed: 'destructive',
  canceled: 'outline',
};

export function AnalyzePage({ loggedIn, selection, onSelectionChange }: Props) {
  const [note, setNote] = useState('');
  const [appName, setAppName] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PipelineJobItem[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelingAll, setCancelingAll] = useState(false);
  const [cancelingJobId, setCancelingJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getPublicAppMeta(selection.appId, selection.country)
      .then((response) => {
        if (mounted) {
          setAppName(response.data.app_name?.trim() || null);
        }
      })
      .catch(() => {
        if (mounted) {
          setAppName(null);
        }
      });

    return () => {
      mounted = false;
    };
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
      setError(err instanceof Error ? err.message : '실행 이력을 불러오지 못했습니다.');
    } finally {
      setLoadingJobs(false);
    }
  };

  useEffect(() => {
    void loadJobs();
  }, [loggedIn]);

  const cancelableCount = useMemo(() => jobs.filter((item) => item.status === 'queued' || item.status === 'running').length, [jobs]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (!loggedIn) {
      setMessage('로그인 후 수집 실행이 가능합니다.');
      return;
    }

    setSubmitting(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('로그인 세션이 만료되었습니다. 다시 로그인하세요.');
      }

      const response = await createPipelineJob(token, {
        appStoreId: selection.appId,
        country: selection.country,
        appName: appName || undefined,
        note: note.trim() || undefined,
      });

      setMessage(`수집 요청이 등록되었습니다. (${response.data.id})`);
      setNote('');
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '실행 요청 등록에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const onCancelJob = async (jobId: string) => {
    if (!loggedIn) {
      return;
    }

    setCancelingJobId(jobId);
    setError(null);
    setMessage(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('로그인 세션이 만료되었습니다. 다시 로그인하세요.');
      }
      const response = await cancelPipelineJobs(token, { jobId });
      setMessage(`${response.canceledCount}건 취소되었습니다.`);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청 취소에 실패했습니다.');
    } finally {
      setCancelingJobId(null);
    }
  };

  const onCancelAll = async () => {
    if (!loggedIn) {
      return;
    }

    setCancelingAll(true);
    setError(null);
    setMessage(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('로그인 세션이 만료되었습니다. 다시 로그인하세요.');
      }
      const response = await cancelPipelineJobs(token, { cancelAll: true, appStoreId: selection.appId, country: selection.country });
      setMessage(`${response.canceledCount}건 취소되었습니다.`);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '일괄 취소에 실패했습니다.');
    } finally {
      setCancelingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader description="App Store ID를 입력해 리뷰 수집을 실행합니다." />

      {message ? (
        <Card className="border-primary/20">
          <CardContent className="p-4 text-sm text-foreground">{message}</CardContent>
        </Card>
      ) : null}

      {error ? (
        <Card className="border-destructive/20">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">수집 요청</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <AppSearchPicker
              selection={selection}
              onSelect={(next) => {
                onSelectionChange(next);
                setAppName(null);
              }}
            />

            <div className="rounded-xl border border-border bg-panel px-4 py-3">
              <p className="text-xs font-medium text-muted-foreground">현재 선택 앱</p>
              <p className="mt-1 text-base font-semibold text-foreground">{appName || `앱 ${selection.appId}`}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {selection.appId} · {selection.country.toUpperCase()}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="run-note">메모</Label>
              <Textarea id="run-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="선택 사항" />
            </div>

            {!loggedIn ? (
              <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-muted-foreground">
                로그인 후 수집 실행이 가능합니다.
              </div>
            ) : null}

            <div className="flex gap-2">
              <Button type="submit" size="lg" className="flex-1" disabled={submitting}>
                {submitting ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" />
                    요청 등록 중...
                  </>
                ) : (
                  <>
                    <Play className="size-4" />
                    수집 실행
                  </>
                )}
              </Button>
              {loggedIn ? (
                <Button variant="outline" size="lg" onClick={onCancelAll} disabled={cancelingAll || cancelableCount === 0}>
                  <XCircle className="size-4" />
                  취소
                </Button>
              ) : (
                <Button asChild variant="outline" size="lg">
                  <Link to="/login">로그인</Link>
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">최근 실행 이력</CardTitle>
          <CardDescription>내 계정 기준 최근 실행 상태입니다.</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingJobs ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="rounded-xl border border-border bg-panel px-4 py-4">
                  <div className="h-4 w-24 animate-pulse rounded-full bg-muted/70" />
                  <div className="mt-3 h-5 w-40 animate-pulse rounded-full bg-muted/70" />
                </div>
              ))}
            </div>
          ) : jobs.length > 0 ? (
            <div className="grid gap-3 xl:grid-cols-2">
              {jobs.map((job) => (
                <div key={job.id} className="rounded-xl border border-border bg-panel px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={STATUS_BADGE[job.status]}>{job.status}</Badge>
                        <Badge variant="outline">{job.country.toUpperCase()}</Badge>
                      </div>
                      <p className="mt-3 text-base font-semibold text-foreground">{job.app_name || `앱 ${job.app_store_id}`}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {job.app_store_id} · 요청 {new Date(job.requested_at).toLocaleString()}
                      </p>
                    </div>
                    {(job.status === 'queued' || job.status === 'running') && loggedIn ? (
                      <Button variant="outline" size="sm" onClick={() => onCancelJob(job.id)} disabled={cancelingJobId === job.id}>
                        {cancelingJobId === job.id ? <LoaderCircle className="size-4 animate-spin" /> : <XCircle className="size-4" />}
                        취소
                      </Button>
                    ) : null}
                  </div>

                  <div className="mt-4 grid gap-2 text-sm text-muted-foreground">
                    <p>메모: {job.note || '없음'}</p>
                    <p>Run ID: {job.run_id || '-'}</p>
                    {job.error_message ? (
                      <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-destructive">{job.error_message}</p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={Play} title="실행 이력이 없습니다." description="수집 실행을 하면 최근 상태가 여기에 표시됩니다." />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
