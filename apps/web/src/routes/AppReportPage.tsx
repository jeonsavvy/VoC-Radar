import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Clock3, RefreshCw, Search, Star, X } from 'lucide-react';
import { Link, NavLink, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { AppArtwork } from '@/components/AppArtwork';
import { getIssueDetail, getPublicReport, getPublicReviews, requestAnalysis } from '@/lib/api';
import {
  ANALYSIS_REQUEST_SESSION_MESSAGE,
  getAnalysisRequestFailureMessage,
} from '@/lib/analysisRequestError';
import { reportPath } from '@/lib/appIdentity';
import { DEFAULT_COUNTRY } from '@/lib/config';
import type { IssueClusterItem, IssueDetail, PublicReport, ReviewItem } from '@/types';

const TABS = ['overview', 'issues', 'reviews'] as const;
type ReportTab = (typeof TABS)[number];

const severityLabel = { high: '높음', medium: '중간', low: '낮음' } as const;

const formatDate = (value: string | null | undefined, withTime = false) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('ko-KR', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
};

export function getIssueAccessibleName(issue: IssueClusterItem) {
  const change = issue.changePercent == null
    ? '비교 없음'
    : issue.changePercent > 0
      ? `${issue.changePercent}% 증가`
      : issue.changePercent < 0
        ? `${Math.abs(issue.changePercent)}% 감소`
        : '0%';
  return `${issue.title} 상세 보기. 카테고리 ${issue.category}, 심각도 ${severityLabel[issue.severity]}, 리뷰 ${issue.reviewCount}건, 변화 ${change}, 근거 리뷰 ${issue.evidenceCount}건, 최근 발생 ${formatDate(issue.lastOccurredAt)}`;
}

function ReportSkeleton() {
  return <div className="report-skeleton" aria-label="리포트 불러오는 중">
    <div /><div /><div /><div /><div />
  </div>;
}

function IssuePanel({ issue, from, to, onClose }: {
  issue: IssueClusterItem | null;
  from: string;
  to: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (issue && !dialog.open) dialog.showModal();
    if (!issue && dialog.open) dialog.close();
  }, [issue]);

  useEffect(() => {
    if (!issue) return;
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    getIssueDetail(issue.issueId, from, to, controller.signal)
      .then((response) => !controller.signal.aborted && setDetail(response.data))
      .catch(() => !controller.signal.aborted && setError(
        '이슈 상세를 불러오지 못했습니다. 현재 리포트는 그대로 유지됩니다. 잠시 후 다시 시도하세요.',
      ));
    return () => controller.abort();
  }, [from, issue, reloadKey, to]);

  return (
    <dialog ref={ref} className="issue-dialog" onClose={onClose} aria-labelledby="issue-dialog-title">
      {issue ? <div className="issue-dialog__body">
        <header>
          <div>
            <span className={`severity severity--${issue.severity}`}>{severityLabel[issue.severity]}</span>
            <h2 id="issue-dialog-title">{issue.title}</h2>
            <p>{issue.category} · 근거 리뷰 {issue.evidenceCount}건</p>
          </div>
          <button type="button" className="icon-button" onClick={() => ref.current?.close()} aria-label="이슈 상세 닫기"><X /></button>
        </header>
        {error ? <div className="error-state" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>다시 시도</button>
        </div> : detail ? <>
          <section className="issue-summary">
            <h3>이슈 요약</h3>
            <p>{detail.issue.summary}</p>
            {detail.issue.actionHint ? <div><strong>다음 확인</strong><span>{detail.issue.actionHint}</span></div> : null}
          </section>
          <section className="evidence-section">
            <div className="section-heading"><h3>근거 리뷰</h3><span>
              {detail.reviews.length < detail.issue.evidenceCount
                ? `${detail.issue.evidenceCount}건 중 ${detail.reviews.length}건`
                : `${detail.issue.evidenceCount}건`}
            </span></div>
            <div className="evidence-list">
              {detail.reviews.map((review) => <article key={review.reviewId} className={review.isRepresentative ? 'is-representative' : ''}>
                <div className="review-meta">
                  <span><Star aria-hidden="true" /> {review.rating}</span>
                  <span>{review.author || '작성자 미상'}</span>
                  <time>{formatDate(review.reviewedAt)}</time>
                  {review.isRepresentative ? <em>대표 근거</em> : null}
                </div>
                <p>{review.content}</p>
                <small>Review ID · {review.reviewId}</small>
              </article>)}
            </div>
          </section>
        </> : <ReportSkeleton />}
      </div> : null}
    </dialog>
  );
}

function IssuesView({ issues, totalCount, onSelect }: {
  issues: IssueClusterItem[];
  totalCount: number;
  onSelect: (issue: IssueClusterItem) => void;
}) {
  if (issues.length === 0) return <div className="quiet-empty">현재 기간에 게시된 이슈가 없습니다.</div>;
  return <section className="issues-table" aria-label="이슈 목록">
    {issues.length < totalCount ? <p className="issues-table__scope" role="status">
      전체 {totalCount.toLocaleString()}건 중 {issues.length.toLocaleString()}건을 표시합니다.
    </p> : null}
    <div className="issues-table__head" aria-hidden="true">
      <span>이슈</span><span>심각도</span><span>리뷰 수</span><span>변화</span><span>근거 리뷰</span><span>최근 발생</span>
    </div>
    <div>
      {issues.map((issue) => <button
        key={issue.issueId}
        type="button"
        className="issue-row"
        aria-label={getIssueAccessibleName(issue)}
        onClick={() => onSelect(issue)}
      >
        <span className="issue-row__name"><strong>{issue.title}</strong><small>{issue.category}</small></span>
        <span><span className={`severity severity--${issue.severity}`}>{severityLabel[issue.severity]}</span></span>
        <span data-label="리뷰 수">{issue.reviewCount}</span>
        <span data-label="변화" className="change-cell">
          {issue.changePercent == null ? <span className="muted">비교 없음</span> : issue.changePercent > 0 ? <><ArrowUp />{issue.changePercent}%</> : issue.changePercent < 0 ? <><ArrowDown />{Math.abs(issue.changePercent)}%</> : '0%'}
        </span>
        <span data-label="근거 리뷰">{issue.evidenceCount}건</span>
        <span data-label="최근 발생">{formatDate(issue.lastOccurredAt)}</span>
      </button>)}
    </div>
  </section>;
}

function OverviewView({ report }: { report: PublicReport }) {
  return <div className="overview-view">
    <div className="metric-grid">
      <div><span>분석 리뷰</span><strong>{report.summary.totalReviews.toLocaleString()}</strong></div>
      <div><span>활성 이슈</span><strong>{report.summary.issueCount.toLocaleString()}</strong></div>
      <div><span>평균 별점</span><strong>{report.summary.averageRating.toFixed(2)}</strong></div>
      <div><span>저평점 비율</span><strong>{report.summary.lowRatingRatio.toFixed(1)}%</strong></div>
    </div>
    <div className="overview-columns">
      <section>
        <div className="section-heading"><h2>리뷰 유형</h2><span>최근 분석 기준</span></div>
        <div className="category-list">{report.categories.map((category) => <div key={category.category}>
          <span>{category.category}</span><strong>{category.sharePercent.toFixed(1)}%</strong><i style={{ width: `${Math.min(category.sharePercent, 100)}%` }} />
        </div>)}</div>
      </section>
      <section>
        <div className="section-heading"><h2>최근 추이</h2><span>일별 리뷰</span></div>
        <div className="trend-list">{report.trends.slice(-7).map((point) => <div key={point.date}>
          <time>{formatDate(point.date)}</time><strong>{point.totalReviews}건</strong><span>★ {point.averageRating.toFixed(1)}</span>
        </div>)}</div>
      </section>
    </div>
  </div>;
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debouncedValue;
}

export function mergeReviewItems(current: ReviewItem[], incoming: ReviewItem[]) {
  const seen = new Set(current.map((review) => review.review_id));
  return current.concat(incoming.filter((review) => {
    if (seen.has(review.review_id)) return false;
    seen.add(review.review_id);
    return true;
  }));
}

type ReviewsResource =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      items: ReviewItem[];
      nextCursor: string | null;
      hasNext: boolean;
      more: 'idle' | 'loading' | 'error';
    };

export function ReviewsView({ appId, country, from, to }: { appId: string; country: string; from: string; to: string }) {
  const [query, setQuery] = useState('');
  const [resource, setResource] = useState<ReviewsResource>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const initialRequest = useRef<AbortController | null>(null);
  const moreRequest = useRef<AbortController | null>(null);
  const debouncedQuery = useDebouncedValue(query.trim(), 350);

  useEffect(() => {
    const controller = new AbortController();
    initialRequest.current = controller;
    moreRequest.current?.abort();
    moreRequest.current = null;
    setResource({ status: 'loading' });

    getPublicReviews(appId, {
      country,
      from,
      to,
      limit: 50,
      search: debouncedQuery || undefined,
      searchScope: 'content',
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        setResource({
          status: 'ready',
          items: mergeReviewItems([], response.data),
          nextCursor: response.nextCursor,
          hasNext: Boolean(response.hasNext && response.nextCursor),
          more: 'idle',
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setResource({
          status: 'error',
          message: '리뷰를 불러오지 못했습니다. 현재 목록은 비어 있습니다. 잠시 후 다시 시도하세요.',
        });
      });

    return () => {
      controller.abort();
      if (initialRequest.current === controller) initialRequest.current = null;
      moreRequest.current?.abort();
      moreRequest.current = null;
    };
  }, [appId, country, debouncedQuery, from, reloadKey, to]);

  const loadMore = useCallback(async () => {
    if (resource.status !== 'ready' || resource.more === 'loading'
      || !resource.hasNext || !resource.nextCursor || moreRequest.current) return;
    const cursor = resource.nextCursor;
    const controller = new AbortController();
    moreRequest.current = controller;
    setResource((current) => current.status === 'ready' ? { ...current, more: 'loading' } : current);

    try {
      const response = await getPublicReviews(appId, {
        country,
        from,
        to,
        limit: 50,
        search: debouncedQuery || undefined,
        searchScope: 'content',
        cursor,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setResource((current) => current.status === 'ready' ? {
        status: 'ready',
        items: mergeReviewItems(current.items, response.data),
        nextCursor: response.nextCursor,
        hasNext: Boolean(response.hasNext && response.nextCursor && response.nextCursor !== cursor),
        more: 'idle',
      } : current);
    } catch {
      if (controller.signal.aborted) return;
      setResource((current) => current.status === 'ready' ? { ...current, more: 'error' } : current);
    } finally {
      if (moreRequest.current === controller) moreRequest.current = null;
    }
  }, [appId, country, debouncedQuery, from, resource, to]);

  return <div className="reviews-view">
    <label className="review-search">
      <Search aria-hidden="true" />
      <span className="sr-only">리뷰 검색</span>
      <input
        value={query}
        onChange={(event) => {
          initialRequest.current?.abort();
          moreRequest.current?.abort();
          moreRequest.current = null;
          setQuery(event.target.value);
          setResource({ status: 'loading' });
        }}
        placeholder="리뷰 내용 검색"
      />
    </label>
    {resource.status === 'loading' ? <ReportSkeleton /> : resource.status === 'error' ? <div className="error-state" role="alert">
      <strong>리뷰를 표시하지 못했습니다.</strong>
      <p>{resource.message}</p>
      <button type="button" onClick={() => setReloadKey((value) => value + 1)}>다시 시도</button>
    </div> : resource.items.length ? <>
      <div className="public-review-list">
        {resource.items.map((review) => <article key={review.review_id}>
          <div className="review-meta"><span><Star aria-hidden="true" /> {review.rating}</span><span>{review.category}</span><time>{formatDate(review.reviewed_at)}</time></div>
          <p>{review.content}</p><small>{review.author || '작성자 미상'} · {review.review_id}</small>
        </article>)}
      </div>
      {resource.more === 'error' ? <p className="review-load-error" role="alert">리뷰를 더 불러오지 못했습니다. 기존 리뷰는 그대로 유지됩니다. 다시 시도하세요.</p> : null}
      {resource.hasNext ? <button
        type="button"
        className="review-load-more"
        disabled={resource.more === 'loading'}
        aria-busy={resource.more === 'loading'}
        onClick={() => void loadMore()}
      >
        {resource.more === 'loading' ? '리뷰 불러오는 중…' : resource.more === 'error' ? '다시 시도' : '리뷰 더 보기'}
      </button> : null}
    </> : <div className="quiet-empty">조건에 맞는 리뷰가 없습니다.</div>}
  </div>;
}

type Props = { loggedIn: boolean; authChecking: boolean };

type ReportResource =
  | { status: 'loading'; scope: string }
  | { status: 'error'; scope: string; message: string }
  | { status: 'ready'; scope: string; data: PublicReport };

export function AppReportPage(props: Props) {
  const { appId = '', country = DEFAULT_COUNTRY, tab = 'overview' } = useParams();
  return <AppReportPageContent {...props} appId={appId} country={country} tab={tab} />;
}

function AppReportPageContent({ loggedIn, authChecking, appId, country, tab }: Props & {
  appId: string;
  country: string;
  tab: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const scope = `${country}:${appId}`;
  const [reportResource, setReportResource] = useState<ReportResource>({ status: 'loading', scope });
  const [selectedIssue, setSelectedIssue] = useState<IssueClusterItem | null>(null);
  const [analysisRequest, setAnalysisRequest] = useState<{
    scope: string;
    status: 'idle' | 'loading' | 'done';
    message: string | null;
  }>({ scope, status: 'idle', message: null });
  const [reloadKey, setReloadKey] = useState(0);
  const requestInFlightScope = useRef<string | null>(null);
  const report = reportResource.scope === scope && reportResource.status === 'ready' ? reportResource.data : null;
  const error = reportResource.scope === scope && reportResource.status === 'error' ? reportResource.message : null;
  const loading = reportResource.scope !== scope || reportResource.status === 'loading';
  const requesting = analysisRequest.scope === scope && analysisRequest.status === 'loading';
  const requestMessage = analysisRequest.scope === scope ? analysisRequest.message : null;

  const activeTab = TABS.includes(tab as ReportTab) ? (tab as ReportTab) : null;

  useEffect(() => {
    setSelectedIssue(null);
  }, [activeTab, scope]);

  useEffect(() => {
    if (!/^\d{5,20}$/.test(appId) || !/^[a-z]{2}$/.test(country)) {
      setReportResource({ status: 'error', scope, message: '유효하지 않은 App Store ID 또는 국가 코드입니다.' });
      return;
    }
    const controller = new AbortController();
    setReportResource({ status: 'loading', scope });
    getPublicReport(appId, country, controller.signal)
      .then((response) => !controller.signal.aborted
        && setReportResource({ status: 'ready', scope, data: response.data }))
      .catch(() => !controller.signal.aborted && setReportResource({
        status: 'error',
        scope,
        message: '리포트를 불러오지 못했습니다. 공개 데이터는 변경되지 않았습니다. 잠시 후 다시 시도하세요.',
      }));
    return () => controller.abort();
  }, [appId, country, reloadKey, scope]);

  if (!activeTab) return <Navigate to={reportPath(appId, country)} replace />;

  const requestRefresh = async () => {
    if (authChecking || requestInFlightScope.current === scope) return;
    if (!loggedIn) {
      navigate(`/login?returnTo=${encodeURIComponent(location.pathname)}`);
      return;
    }
    requestInFlightScope.current = scope;
    setAnalysisRequest({ scope, status: 'loading', message: null });
    try {
      const { getAccessToken } = await import('@/lib/auth');
      const token = await getAccessToken();
      if (!token) {
        setAnalysisRequest({ scope, status: 'done', message: ANALYSIS_REQUEST_SESSION_MESSAGE });
        return;
      }
      const response = await requestAnalysis(token, { appStoreId: appId, country, appName: report?.app.appName || undefined });
      setAnalysisRequest({
        scope,
        status: 'done',
        message: response.result === 'fresh'
          ? `재분석 가능: ${formatDate(response.data.nextAllowedAt, true)}`
          : response.result === 'existing' ? '이미 진행 중인 분석 요청이 있습니다.' : '분석 요청을 대기열에 등록했습니다.',
      });
    } catch (error) {
      setAnalysisRequest({
        scope,
        status: 'done',
        message: getAnalysisRequestFailureMessage(
          error,
          '분석 요청 상태를 확인하지 못했습니다. 동일 요청이 이미 등록되었을 수 있습니다. 요청 내역을 확인한 뒤 다시 시도하세요.',
        ),
      });
    } finally {
      if (requestInFlightScope.current === scope) requestInFlightScope.current = null;
    }
  };

  return <div className="report-page">
    {loading ? <ReportSkeleton /> : error ? <div className="error-state" role="alert"><strong>리포트를 열 수 없습니다.</strong><p>{error}</p><button type="button" onClick={() => setReloadKey((value) => value + 1)}>다시 시도</button><Link to="/">앱 다시 찾기</Link></div> : report ? <>
      <header className="app-report-header">
        <div className="app-report-header__identity">
          <AppArtwork
            artworkUrl={report.app.artworkUrl}
            appName={report.app.appName}
            appStoreId={report.app.appStoreId}
            country={report.app.country}
            size="large"
          />
          <div><h1>{report.app.appName || `App ${appId}`}</h1><p>{appId} · {country.toUpperCase()} · 최근 30일</p></div>
        </div>
        <div className="app-report-header__meta">
          <span><Clock3 /> 마지막 분석 {formatDate(report.analysis.lastAnalyzedAt, true)}</span>
          <button type="button" className="refresh-button" onClick={requestRefresh} disabled={requesting || authChecking}>
            <RefreshCw className={requesting ? 'is-spinning' : ''} /> {requesting ? '요청 중' : '분석 새로고침'}
          </button>
        </div>
      </header>
      {requestMessage ? <div className="request-banner" role="status">{requestMessage}<Link to="/requests">요청 내역 <ArrowRight /></Link></div> : null}

      <nav className="report-tabs" aria-label="리포트 보기">
        <NavLink to={reportPath(appId, country, 'overview')}>개요</NavLink>
        <NavLink to={reportPath(appId, country, 'issues')}>이슈 <span>{report.summary.issueCount}</span></NavLink>
        <NavLink to={reportPath(appId, country, 'reviews')}>리뷰</NavLink>
      </nav>

      {report.analysis.status === 'not_analyzed' ? <section className="not-analyzed">
        <h2>분석 결과 없음</h2>
        <button type="button" onClick={requestRefresh} disabled={requesting || authChecking}><RefreshCw className={requesting ? 'is-spinning' : ''} /> {requesting ? '요청 중' : '분석 요청'}</button>
      </section> : <section className="report-content">
        {activeTab === 'issues' ? <IssuesView issues={report.issues} totalCount={report.summary.issueCount} onSelect={setSelectedIssue} /> : null}
        {activeTab === 'overview' ? <OverviewView report={report} /> : null}
        {activeTab === 'reviews' ? <ReviewsView appId={appId} country={country} from={report.window.from} to={report.window.to} /> : null}
      </section>}
      <IssuePanel
        issue={selectedIssue}
        from={report.window.from}
        to={report.window.to}
        onClose={() => setSelectedIssue(null)}
      />
    </> : null}
  </div>;
}
