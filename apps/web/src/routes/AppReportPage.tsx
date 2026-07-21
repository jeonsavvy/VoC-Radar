import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Clock3, RefreshCw, Search, Star, X } from 'lucide-react';
import { Link, NavLink, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { getIssueDetail, getPublicReport, getPublicReviews, requestAnalysis } from '@/lib/api';
import { reportPath } from '@/lib/appIdentity';
import { getAccessToken } from '@/lib/auth';
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

function ReportSkeleton() {
  return <div className="report-skeleton" aria-label="리포트 불러오는 중">
    <div /><div /><div /><div /><div />
  </div>;
}

function IssuePanel({ issue, onClose }: { issue: IssueClusterItem | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    getIssueDetail(issue.issueId)
      .then((response) => active && setDetail(response.data))
      .catch((err) => active && setError(err instanceof Error ? err.message : '이슈 상세를 불러오지 못했습니다.'));
    return () => { active = false; };
  }, [issue]);

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
        {error ? <div className="error-state">{error}</div> : detail ? <>
          <section className="issue-summary">
            <h3>이슈 요약</h3>
            <p>{detail.issue.summary}</p>
            {detail.issue.actionHint ? <div><strong>다음 확인</strong><span>{detail.issue.actionHint}</span></div> : null}
          </section>
          <section className="evidence-section">
            <div className="section-heading"><h3>근거 리뷰</h3><span>{detail.reviews.length}건</span></div>
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
          <footer className="model-meta">
            <span>Run {detail.issue.runId}</span>
            <span>{detail.issue.modelVersion}</span>
            <span>검증 {detail.issue.validation?.passed === true ? '통과' : '기록됨'}</span>
          </footer>
        </> : <ReportSkeleton />}
      </div> : null}
    </dialog>
  );
}

function IssuesView({ issues, onSelect }: { issues: IssueClusterItem[]; onSelect: (issue: IssueClusterItem) => void }) {
  if (issues.length === 0) return <div className="quiet-empty">현재 기간에 게시된 이슈가 없습니다.</div>;
  return <section className="issues-table" aria-label="이슈 목록">
    <div className="issues-table__head" aria-hidden="true">
      <span>이슈</span><span>심각도</span><span>리뷰 수</span><span>변화</span><span>근거 리뷰</span><span>최근 발생</span>
    </div>
    <div>
      {issues.map((issue) => <button
        key={issue.issueId}
        type="button"
        className="issue-row"
        aria-label={`${issue.title} 상세 보기. 심각도 ${severityLabel[issue.severity]}, 근거 리뷰 ${issue.evidenceCount}건`}
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

function ReviewsView({ appId, country }: { appId: string; country: string }) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    getPublicReviews(appId, { country, limit: 50, search: query.trim() || undefined })
      .then((response) => active && setItems(response.data))
      .catch((err) => active && setError(err instanceof Error ? err.message : '리뷰를 불러오지 못했습니다.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [appId, country, query]);
  return <div className="reviews-view">
    <label className="review-search"><Search /><span className="sr-only">리뷰 검색</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="리뷰 내용 검색" /></label>
    {error ? <div className="error-state">{error}</div> : loading ? <ReportSkeleton /> : items.length ? <div className="public-review-list">
      {items.map((review) => <article key={review.review_id}>
        <div className="review-meta"><span><Star /> {review.rating}</span><span>{review.category}</span><time>{formatDate(review.reviewed_at)}</time></div>
        <p>{review.content}</p><small>{review.author || '작성자 미상'} · {review.review_id}</small>
      </article>)}
    </div> : <div className="quiet-empty">조건에 맞는 리뷰가 없습니다.</div>}
  </div>;
}

type Props = { loggedIn: boolean };

export function AppReportPage({ loggedIn }: Props) {
  const { appId = '', country = 'kr', tab = 'overview' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [report, setReport] = useState<PublicReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueClusterItem | null>(null);
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const activeTab = TABS.includes(tab as ReportTab) ? (tab as ReportTab) : null;

  useEffect(() => {
    if (!/^\d{5,20}$/.test(appId) || !/^[a-z]{2}$/.test(country)) {
      setError('유효하지 않은 App Store ID 또는 국가 코드입니다.');
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true); setError(null);
    getPublicReport(appId, country)
      .then((response) => active && setReport(response.data))
      .catch((err) => active && setError(err instanceof Error ? err.message : '리포트를 불러오지 못했습니다.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [appId, country]);

  if (!activeTab) return <Navigate to={reportPath(appId, country)} replace />;

  const requestRefresh = async () => {
    if (!loggedIn) {
      navigate(`/login?returnTo=${encodeURIComponent(location.pathname)}`);
      return;
    }
    setRequesting(true); setRequestMessage(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('로그인이 필요합니다.');
      const response = await requestAnalysis(token, { appStoreId: appId, country, appName: report?.app.appName || undefined });
      setRequestMessage(response.result === 'fresh'
        ? `재분석 가능: ${formatDate(response.data.nextAllowedAt, true)}`
        : response.result === 'existing' ? '이미 진행 중인 분석 요청이 있습니다.' : '분석 요청을 대기열에 등록했습니다.');
    } catch (err) {
      setRequestMessage(err instanceof Error ? err.message : '분석 요청에 실패했습니다.');
    } finally { setRequesting(false); }
  };

  return <div className="report-page">
    {loading ? <ReportSkeleton /> : error ? <div className="error-state"><strong>리포트를 열 수 없습니다.</strong><p>{error}</p><Link to="/">앱 다시 찾기</Link></div> : report ? <>
      <header className="app-report-header">
        <div className="app-report-header__identity">
          <span className="app-initial app-initial--large">{report.app.appName?.[0] || 'A'}</span>
          <div><h1>{report.app.appName || `App ${appId}`}</h1><p>{appId} · {country.toUpperCase()} · 최근 30일</p></div>
        </div>
        <div className="app-report-header__meta">
          <span><Clock3 /> 마지막 분석 {formatDate(report.analysis.lastAnalyzedAt, true)}</span>
          <button type="button" className="refresh-button" onClick={requestRefresh} disabled={requesting}>
            <RefreshCw className={requesting ? 'is-spinning' : ''} /> {requesting ? '요청 중' : '분석 새로고침'}
          </button>
        </div>
      </header>
      {report.analysis.stale ? <div className="stale-banner">마지막 분석 후 24시간이 지났습니다.</div> : null}
      {requestMessage ? <div className="request-banner" role="status">{requestMessage}<Link to="/requests">요청 내역 <ArrowRight /></Link></div> : null}

      <nav className="report-tabs" aria-label="리포트 보기">
        <NavLink to={reportPath(appId, country, 'overview')}>개요</NavLink>
        <NavLink to={reportPath(appId, country, 'issues')}>이슈 <span>{report.issues.length}</span></NavLink>
        <NavLink to={reportPath(appId, country, 'reviews')}>리뷰</NavLink>
      </nav>

      {report.analysis.status === 'not_analyzed' ? <section className="not-analyzed">
        <h2>분석 결과 없음</h2>
        <button type="button" onClick={requestRefresh}><RefreshCw /> 분석 요청</button>
      </section> : <section className="report-content">
        {activeTab === 'issues' ? <IssuesView issues={report.issues} onSelect={setSelectedIssue} /> : null}
        {activeTab === 'overview' ? <OverviewView report={report} /> : null}
        {activeTab === 'reviews' ? <ReviewsView appId={appId} country={country} /> : null}
      </section>}
      <IssuePanel issue={selectedIssue} onClose={() => setSelectedIssue(null)} />
    </> : null}
  </div>;
}
