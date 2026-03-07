import { FormEvent, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Bot,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Play,
  ShieldCheck,
  SquareTerminal,
  Workflow,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { cancelPipelineJobs, createPipelineJob, getMyPipelineJobs, getPublicAppMeta } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { isValidAppId, normalizeCountry, type AppSelection } from '@/lib/appSelection';
import type { PipelineJobItem } from '@/types';

type Props = {
  loggedIn: boolean;
  selection: AppSelection;
  onSelectionChange: (next: AppSelection) => void;
};

const STATUS_CONFIG: Record<
  PipelineJobItem['status'],
  { label: string; variant: 'default' | 'secondary' | 'warning' | 'success' | 'destructive' | 'outline' }
> = {
  queued: { label: 'Queued', variant: 'secondary' },
  running: { label: 'Running', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  canceled: { label: 'Canceled', variant: 'outline' },
};

const PIPELINE_STEPS = [
  {
    title: 'Queue 등록',
    description: '웹에서 app/country/note를 함께 저장하고 즉시 n8n webhook을 트리거합니다.',
    icon: SquareTerminal,
  },
  {
    title: '리뷰 수집',
    description: 'Worker가 iTunes RSS를 기준으로 최대 30일/120페이지까지 데이터를 정리합니다.',
    icon: Workflow,
  },
  {
    title: 'LLM 분류',
    description: 'n8n이 중복을 제거한 뒤 priority/category/summary를 배치 단위로 판별합니다.',
    icon: Bot,
  },
  {
    title: 'Publish',
    description: 'Supabase upsert 후 공개 캐시 버전을 갱신해 리포트에 즉시 반영합니다.',
    icon: ShieldCheck,
  },
] as const;

export function AnalyzePage({ loggedIn, selection, onSelectionChange }: Props) {
  const [appId, setAppId] = useState(selection.appId);
  const [country, setCountry] = useState(selection.country);
  const [note, setNote] = useState('');
  const [appName, setAppName] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PipelineJobItem[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelingJobId, setCancelingJobId] = useState<string | null>(null);
  const [cancelingAll, setCancelingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAppId(selection.appId);
    setCountry(selection.country);
  }, [selection.appId, selection.country]);

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
      setError(err instanceof Error ? err.message : '요청 이력을 불러오지 못했습니다.');
    } finally {
      setLoadingJobs(false);
    }
  };

  useEffect(() => {
    void loadJobs();
  }, [loggedIn]);

  const cancelableStatuses: PipelineJobItem['status'][] = ['queued', 'running'];
  const cancelableJobCount = jobs.filter((job) => cancelableStatuses.includes(job.status)).length;
  const runningCount = jobs.filter((job) => job.status === 'running').length;

  const onCancelJob = async (jobId: string) => {
    if (!loggedIn || !window.confirm('이 요청을 취소할까요?')) {
      return;
    }

    setError(null);
    setMessage(null);
    setCancelingJobId(jobId);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('로그인 세션이 만료되었습니다. 다시 로그인하세요.');
      }
      const response = await cancelPipelineJobs(token, { jobId });
      setMessage(`요청 취소 완료: ${response.canceledCount}건`);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청 취소에 실패했습니다.');
    } finally {
      setCancelingJobId(null);
    }
  };

  const onCancelAll = async () => {
    if (!loggedIn || !window.confirm('대기/실행중 요청을 모두 취소할까요?')) {
      return;
    }

    setError(null);
    setMessage(null);
    setCancelingAll(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('로그인 세션이 만료되었습니다. 다시 로그인하세요.');
      }
      const response = await cancelPipelineJobs(token, { cancelAll: true });
      setMessage(`요청 일괄 취소 완료: ${response.canceledCount}건`);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '일괄 취소에 실패했습니다.');
    } finally {
      setCancelingAll(false);
    }
  };

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
      setMessage('앱 컨텍스트만 반영되었습니다. 실제 파이프라인 등록은 로그인 후 가능합니다.');
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
        appName: appName || undefined,
        note: note.trim() || undefined,
      });

      if (response.trigger?.dispatched === false) {
        setMessage(`요청 등록 완료: ${response.data.id} (즉시 트리거 미설정/실패, n8n 1분 폴링으로 처리됩니다)`);
      } else {
        setMessage(`요청 등록 완료: ${response.data.id} (n8n 즉시 실행 트리거 전송 완료)`);
      }
      setNote('');
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청 등록에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const queueSummary = useMemo(
    () => `${jobs.length.toLocaleString()} jobs · ${runningCount.toLocaleString()} running · ${cancelableJobCount.toLocaleString()} cancelable`,
    [jobs.length, runningCount, cancelableJobCount],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pipeline Console"
        title="리뷰 수집부터 publish까지 한 번에 제어합니다."
        description="작업 큐 등록, 최근 요청 상태 확인, 취소 제어를 하나의 콘솔로 묶었습니다. 운영자는 여기서 실행 지점을 만들고, 상세 분석은 Reviews 워크벤치에서 이어서 확인하면 됩니다."
        status={queueSummary}
        meta={`${selection.appId} · ${selection.country.toUpperCase()}`}
        actions={
          loggedIn ? (
            <Button variant="outline" onClick={onCancelAll} disabled={cancelingAll || cancelableJobCount === 0}>
              {cancelingAll ? <LoaderCircle className="size-4 animate-spin" /> : <CircleAlert className="size-4" />}
              대기/실행중 전체 취소
            </Button>
          ) : (
            <Button asChild>
              <Link to="/login">로그인 후 요청 등록</Link>
            </Button>
          )
        }
      />

      {message ? (
        <Card className="border-primary/20 bg-primary/8">
          <CardContent className="p-4 text-sm text-foreground">{message}</CardContent>
        </Card>
      ) : null}

      {error ? (
        <Card className="border-destructive/30">
          <CardContent className="p-4 text-sm text-destructive" role="alert">
            {error}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Play className="size-5 text-primary" />
              실행 요청 등록
            </CardTitle>
            <CardDescription>
              선택 앱 컨텍스트를 유지한 채 Queue에 작업을 등록합니다. webhook이 비활성화되어도 1분 폴링 fallback으로 처리됩니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={onSubmit}>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="analyze-app-id">App Store ID</Label>
                  <Input
                    id="analyze-app-id"
                    value={appId}
                    onChange={(event) => setAppId(event.target.value)}
                    placeholder="625257520"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="analyze-country">Country</Label>
                  <Input
                    id="analyze-country"
                    value={country}
                    onChange={(event) => setCountry(event.target.value)}
                    placeholder="kr"
                    maxLength={2}
                    required
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-border/70 bg-background/35 p-4">
                <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Current target</p>
                <p className="mt-2 text-lg font-semibold text-foreground">{appName || 'Unknown App'}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Worker → n8n → LLM → publish 흐름으로 처리됩니다.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="analyze-note">운영 메모 (선택)</Label>
                <Textarea
                  id="analyze-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="예: 1점 리뷰 급증 원인 확인, 신규 릴리즈 직후 반응 추적"
                />
              </div>

              {!loggedIn ? (
                <div className="rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-muted-foreground">
                  상세 권한이 없어 현재는 앱 컨텍스트만 저장됩니다. 실제 요청 등록은{' '}
                  <Link to="/login" className="font-medium text-foreground underline underline-offset-4">
                    로그인
                  </Link>
                  후 가능합니다.
                </div>
              ) : null}

              <Button type="submit" size="lg" disabled={submitting} className="justify-between">
                {submitting ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" />
                    요청 등록 중...
                  </>
                ) : (
                  <>
                    <Play className="size-4" />
                    파이프라인 실행 요청
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Workflow className="size-5 text-primary" />
              실행 흐름 맵
            </CardTitle>
            <CardDescription>현재 백엔드/워크플로우 구현을 기준으로 실제 동작 순서를 정리했습니다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {PIPELINE_STEPS.map((step, index) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.title}
                  initial={{ opacity: 0, x: 18 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: index * 0.04 }}
                  className="rounded-2xl border border-border/70 bg-background/35 p-4"
                >
                  <div className="flex items-start gap-4">
                    <div className="rounded-2xl border border-border/70 bg-secondary/60 p-3 text-primary">
                      <Icon className="size-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{index + 1}</Badge>
                        <p className="text-sm font-semibold text-foreground">{step.title}</p>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">{step.description}</p>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-xl">
                <Clock3 className="size-5 text-primary" />
                최근 요청 상태
              </CardTitle>
              <CardDescription>로그인 사용자 기준의 최신 10건을 표시합니다.</CardDescription>
            </div>
            <Badge variant="secondary">{queueSummary}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadingJobs ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Card key={index} className="bg-background/35">
                  <CardContent className="space-y-3 p-4">
                    <div className="h-4 w-28 animate-pulse rounded-full bg-muted/70" />
                    <div className="h-5 w-40 animate-pulse rounded-full bg-muted/70" />
                    <div className="h-4 w-full animate-pulse rounded-full bg-muted/70" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : jobs.length === 0 ? (
            <EmptyState
              icon={Workflow}
              title="요청 이력이 없습니다"
              description="새로운 파이프라인 요청을 등록하면 이 영역에서 상태 전이를 확인할 수 있습니다."
            />
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {jobs.map((job, index) => {
                const status = STATUS_CONFIG[job.status];
                const isCancelable = cancelableStatuses.includes(job.status);
                return (
                  <motion.div
                    key={job.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.24, delay: index * 0.02 }}
                  >
                    <Card className="h-full bg-background/35">
                      <CardContent className="space-y-4 p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={status.variant}>{status.label}</Badge>
                              <Badge variant="outline">{job.source}</Badge>
                            </div>
                            <p className="mt-3 text-lg font-semibold text-foreground">
                              {job.app_name || '이름 미확인 앱'}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {job.app_store_id} · {job.country.toUpperCase()}
                            </p>
                          </div>
                          {isCancelable ? (
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => onCancelJob(job.id)}
                              disabled={cancelingJobId === job.id}
                            >
                              {cancelingJobId === job.id ? <LoaderCircle className="size-4 animate-spin" /> : <CircleAlert className="size-4" />}
                              취소
                            </Button>
                          ) : null}
                        </div>

                        <Separator />

                        <div className="grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                          <div>
                            <p className="text-xs uppercase tracking-[0.22em]">Requested</p>
                            <p className="mt-1 text-foreground">{new Date(job.requested_at).toLocaleString()}</p>
                          </div>
                          <div>
                            <p className="text-xs uppercase tracking-[0.22em]">Run ID</p>
                            <p className="mt-1 break-all font-mono text-foreground">{job.run_id || '-'}</p>
                          </div>
                          <div className="md:col-span-2">
                            <p className="text-xs uppercase tracking-[0.22em]">Note</p>
                            <p className="mt-1 text-foreground">{job.note || '운영 메모 없음'}</p>
                          </div>
                          {job.error_message ? (
                            <div className="md:col-span-2 rounded-2xl border border-destructive/25 bg-destructive/10 p-3 text-destructive">
                              {job.error_message}
                            </div>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
