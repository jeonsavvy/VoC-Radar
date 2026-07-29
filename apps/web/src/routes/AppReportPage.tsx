import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
const REPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const REPORT_WINDOW_BUCKET_MS = 24 * 60 * 60 * 1000;

const formatDate = (value: string | null | undefined, withTime = false) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('ko-KR', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
};

export function createRecentReviewWindow(now = new Date()) {
  // Inclusive filters must stop 1 ms before the next UTC day to avoid sharing
  // the midnight review with two adjacent calendar windows.
  const nextUtcMidnightMs = (Math.floor(now.getTime() / REPORT_WINDOW_BUCKET_MS) + 1)
    * REPORT_WINDOW_BUCKET_MS;
  const from = new Date(nextUtcMidnightMs - REPORT_WINDOW_MS);
  const to = new Date(nextUtcMidnightMs - 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

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
    let active = true;
    setDetail(null);
    setError(null);
    getIssueDetail(issue.issueId, from, to)
      .then((response) => active && setDetail(response.data))
      .catch(() => active && setError(
        '이슈 상세를 불러오지 못했습니다. 현재 리포트는 그대로 유지됩니다. 잠시 후 다시 시도하세요.',
      ));
    return () => { active = false; };
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

function useDebouncedValue<T>(value: T, revision: number, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState({ value, revision });

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue((current) =>
      Object.is(current.value, value) && current.revision === revision ? current : { value, revision },
    ), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, revision, value]);

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

function ReviewsView({ appId, country, from, to }: { appId: string; country: string; from: string; to: string }) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [query, setQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [queryRevision, setQueryRevision] = useState(0);
  const [error, setError] = useState<{ scope: 'initial' | 'more'; message: string } | null>(null);
  const requestSequence = useRef(0);
  const loadMoreInFlight = useRef<string | null>(null);
  const debouncedSearch = useDebouncedValue(query.trim(), queryRevision, 350);
  const debouncedQuery = debouncedSearch.value;

  useEffect(() => {
    let active = true;
    const requestId = ++requestSequence.current;
    loadMoreInFlight.current = null;
    setItems([]);
    setNextCursor(null);
    setHasNext(false);
    setLoading(true);
    setLoadingMore(false);
    setError(null);

    getPublicReviews(appId, {
      country,
      from,
      to,
      limit: 50,
      search: debouncedQuery || undefined,
      searchScope: 'content',
    })
      .then((response) => {
        if (!active || requestId !== requestSequence.current) return;
        setItems(mergeReviewItems([], response.data));
        setNextCursor(response.nextCursor);
        setHasNext(Boolean(response.hasNext && response.nextCursor));
      })
      .catch(() => {
        if (!active || requestId !== requestSequence.current) return;
        setError({
          scope: 'initial',
          message: '리뷰를 불러오지 못했습니다. 현재 목록은 비어 있습니다. 잠시 후 다시 시도하세요.',
        });
      })
      .finally(() => {
        if (active && requestId === requestSequence.current) setLoading(false);
      });

    return () => { active = false; };
  }, [appId, country, debouncedQuery, debouncedSearch.revision, from, reloadKey, to]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !hasNext || !nextCursor) return;

    const requestId = requestSequence.current;
    const requestKey = `${requestId}:${nextCursor}`;
    if (loadMoreInFlight.current === requestKey) return;
    loadMoreInFlight.current = requestKey;
    setLoadingMore(true);
    setError(null);

    try {
      const response = await getPublicReviews(appId, {
        country,
        from,
        to,
        limit: 50,
        search: debouncedQuery || undefined,
        searchScope: 'content',
        cursor: nextCursor,
      });
      if (requestId !== requestSequence.current) return;

      setItems((current) => mergeReviewItems(current, response.data));
      setNextCursor(response.nextCursor);
      setHasNext(Boolean(response.hasNext && response.nextCursor && response.nextCursor !== nextCursor));
    } catch {
      if (requestId !== requestSequence.current) return;
      setError({
        scope: 'more',
        message: '리뷰를 더 불러오지 못했습니다. 기존 리뷰는 그대로 유지됩니다. 다시 시도하세요.',
      });
    } finally {
      if (loadMoreInFlight.current === requestKey) loadMoreInFlight.current = null;
      if (requestId === requestSequence.current) setLoadingMore(false);
    }
  }, [appId, country, debouncedQuery, from, hasNext, loading, loadingMore, nextCursor, to]);

  return <div className="reviews-view">
    <label className="review-search">
      <Search aria-hidden="true" />
      <span className="sr-only">리뷰 검색</span>
      <input
        value={query}
        onChange={(event) => {
          requestSequence.current += 1;
          loadMoreInFlight.current = null;
          setLoadingMore(false);
          setItems([]);
          setNextCursor(null);
          setHasNext(false);
          setLoading(true);
          setQuery(event.target.value);
          setQueryRevision((value) => value + 1);
          setError(null);
        }}
        placeholder="리뷰 내용 검색"
      />
    </label>
    {loading ? <ReportSkeleton /> : error?.scope === 'initial' ? <div className="error-state" role="alert">
      <strong>리뷰를 표시하지 못했습니다.</strong>
      <p>{error.message}</p>
      <button type="button" onClick={() => setReloadKey((value) => value + 1)}>다시 시도</button>
    </div> : items.length ? <>
      <div className="public-review-list">
        {items.map((review) => <article key={review.review_id}>
          <div className="review-meta"><span><Star aria-hidden="true" /> {review.rating}</span><span>{review.category}</span><time>{formatDate(review.reviewed_at)}</time></div>
          <p>{review.content}</p><small>{review.author || '작성자 미상'} · {review.review_id}</small>
        </article>)}
      </div>
      {error?.scope === 'more' ? <p className="review-load-error" role="alert">{error.message}</p> : null}
      {hasNext ? <button
        type="button"
        className="review-load-more"
        disabled={loadingMore}
        aria-busy={loadingMore}
        onClick={() => void loadMore()}
      >
        {loadingMore ? '리뷰 불러오는 중…' : error?.scope === 'more' ? '다시 시도' : '리뷰 더 보기'}
      </button> : null}
    </> : <div className="quiet-empty">조건에 맞는 리뷰가 없습니다.</div>}
  </div>;
}

type Props = { loggedIn: boolean; authChecking: boolean };

export function AppReportPage(props: Props) {
  const { appId = '', country = DEFAULT_COUNTRY, tab = 'overview' } = useParams();
  const appScope = `${country}:${appId}`;
  return <AppReportPageContent key={appScope} {...props} appId={appId} country={country} tab={tab} />;
}

function AppReportPageContent({ loggedIn, authChecking, appId, country, tab }: Props & {
  appId: string;
  country: string;
  tab: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [report, setReport] = useState<PublicReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueClusterItem | null>(null);
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const requestInFlight = useRef(false);
  const reportWindow = useMemo(() => createRecentReviewWindow(), [appId, country, reloadKey]);

  const activeTab = TABS.includes(tab as ReportTab) ? (tab as ReportTab) : null;

  useEffect(() => {
    if (activeTab !== 'issues') setSelectedIssue(null);
  }, [activeTab]);

  useEffect(() => {
    if (!/^\d{5,20}$/.test(appId) || !/^[a-z]{2}$/.test(country)) {
      setError('유효하지 않은 App Store ID 또는 국가 코드입니다.');
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true); setError(null);
    getPublicReport(appId, country, reportWindow.from, reportWindow.to)
      .then((response) => active && setReport(response.data))
      .catch(() => active && setError(
        '리포트를 불러오지 못했습니다. 공개 데이터는 변경되지 않았습니다. 잠시 후 다시 시도하세요.',
      ))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [appId, country, reloadKey, reportWindow.from, reportWindow.to]);

  if (!activeTab) return <Navigate to={reportPath(appId, country)} replace />;

  const requestRefresh = async () => {
    if (authChecking || requestInFlight.current) return;
    if (!loggedIn) {
      navigate(`/login?returnTo=${encodeURIComponent(location.pathname)}`);
      return;
    }
    requestInFlight.current = true;
    setRequesting(true); setRequestMessage(null);
    try {
      const { getAccessToken } = await import('@/lib/auth');
      const token = await getAccessToken();
      if (!token) {
        setRequestMessage(ANALYSIS_REQUEST_SESSION_MESSAGE);
        return;
      }
      const response = await requestAnalysis(token, { appStoreId: appId, country, appName: report?.app.appName || undefined });
      setRequestMessage(response.result === 'fresh'
        ? `재분석 가능: ${formatDate(response.data.nextAllowedAt, true)}`
        : response.result === 'existing' ? '이미 진행 중인 분석 요청이 있습니다.' : '분석 요청을 대기열에 등록했습니다.');
    } catch (error) {
      setRequestMessage(getAnalysisRequestFailureMessage(
        error,
        '분석 요청 상태를 확인하지 못했습니다. 동일 요청이 이미 등록되었을 수 있습니다. 요청 내역을 확인한 뒤 다시 시도하세요.',
      ));
    } finally {
      requestInFlight.current = false;
      setRequesting(false);
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
        {activeTab === 'reviews' ? <ReviewsView appId={appId} country={country} from={reportWindow.from} to={reportWindow.to} /> : null}
      </section>}
      <IssuePanel
        issue={selectedIssue}
        from={reportWindow.from}
        to={reportWindow.to}
        onClose={() => setSelectedIssue(null)}
      />
    </> : null}
  </div>;
}
