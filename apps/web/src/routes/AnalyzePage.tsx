import { FormEvent, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, LoaderCircle, Play, RefreshCw, XCircle } from 'lucide-react';
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
import { type AppSelection } from '@/lib/appSelection';
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
      setMessage('로그인 후 실제 수집 실행을 요청할 수 있습니다.');
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

      setMessage(
        response.trigger?.dispatched === false
          ? `실행 요청이 등록되었습니다. (${response.data.id}) 즉시 트리거 실패 시 1분 폴링으로 이어집니다.`
          : `실행 요청이 등록되었습니다. (${response.data.id})`,
      );
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
      <PageHeader
        eyebrow="수집 실행"
        title="리뷰 수집을 실행하고 최근 처리 상태를 확인합니다."
        description="앱을 선택한 뒤 수집을 요청하면 Worker → n8n → 분류 → 반영 흐름으로 이어집니다. 실패나 지연이 생기면 최근 실행 이력에서 바로 확인합니다."
        status={jobs.length > 0 ? `최근 실행 ${jobs.length}건` : '실행 대기'}
        meta={`${selection.appId} · ${selection.country.toUpperCase()}`}
        actions={
          loggedIn ? (
            <Button variant="outline" onClick={onCancelAll} disabled={cancelingAll || cancelableCount === 0}>
              <XCircle className="size-4" />
              실행 중/대기 취소
            </Button>
          ) : (
            <Button asChild>
              <Link to="/login">로그인 후 실행 요청</Link>
            </Button>
          )
        }
      />

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

      <div className="grid gap-4 xl:grid-cols-[1.08fr_0.92fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">수집 요청</CardTitle>
            <CardDescription>앱을 선택하고 실행 메모를 남기면 바로 수집을 시작할 수 있습니다.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={onSubmit}>
              <AppSearchPicker
                selection={selection}
                appName={appName}
                onSelect={(next, meta) => {
                  onSelectionChange(next);
                  setAppName(meta?.appName?.trim() || null);
                }}
              />

              <div className="rounded-xl border border-border bg-panel px-4 py-3">
                <p className="text-xs font-medium text-muted-foreground">현재 선택 앱</p>
                <p className="mt-1 text-base font-semibold text-foreground">{appName || '앱명 확인 중'}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selection.appId} · {selection.country.toUpperCase()}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="run-note">실행 메모</Label>
                <Textarea
                  id="run-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="예: 신규 릴리즈 이후 1점 리뷰 증가 원인 확인"
                />
              </div>

              {!loggedIn ? (
                <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-muted-foreground">
                  로그인 전에는 앱 컨텍스트만 바꿀 수 있습니다. 실제 수집 요청은 로그인 후 가능합니다.
                </div>
              ) : null}

              <Button type="submit" size="lg" className="w-full" disabled={submitting}>
                {submitting ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" />
                    요청 등록 중...
                  </>
                ) : (
                  <>
                    <Play className="size-4" />
                    리뷰 수집 요청
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">실행 흐름</CardTitle>
            <CardDescription>현재 파이프라인이 어떤 단계로 이어지는지 짧게 정리했습니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { icon: Play, title: '1. 수집 요청 등록', body: '앱/국가/메모를 저장하고 실행 큐에 올립니다.' },
              { icon: RefreshCw, title: '2. 리뷰 수집 및 중복 제거', body: '최근 리뷰를 가져오고 이미 저장된 리뷰는 제외합니다.' },
              { icon: CheckCircle2, title: '3. 분류 및 반영', body: '문제 유형·원인·권장 액션을 생성한 뒤 대시보드에 반영합니다.' },
            ].map((step) => {
              const Icon = step.icon;
              return (
                <div key={step.title} className="rounded-xl border border-border bg-panel px-4 py-4">
                  <div className="flex items-start gap-3">
                    <div className="rounded-full bg-primary/10 p-2 text-primary">
                      <Icon className="size-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{step.title}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-end justify-between gap-3">
            <div>
              <CardTitle className="text-xl">최근 실행 이력</CardTitle>
              <CardDescription>내 계정 기준 최근 실행 상태를 확인합니다.</CardDescription>
            </div>
            <Badge variant="outline">{cancelableCount}건 취소 가능</Badge>
          </div>
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
                      <p className="mt-3 text-base font-semibold text-foreground">{job.app_name || '앱 이름 미확인'}</p>
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
                      <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-destructive">
                        <AlertCircle className="mr-2 inline size-4" />
                        {job.error_message}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={Play} title="아직 실행 이력이 없습니다." description="수집 요청을 등록하면 여기에서 최근 상태를 확인할 수 있습니다." />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
