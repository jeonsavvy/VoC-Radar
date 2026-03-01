import { useEffect, useMemo, useState } from 'react';
import { getTrends } from '../lib/api';
import type { AppSelection } from '../lib/appSelection';
import type { PublicTrendPoint } from '../types';

type Props = {
  selection: AppSelection;
};

export function TrendsPage({ selection }: Props) {
  const [points, setPoints] = useState<PublicTrendPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    getTrends(selection.appId, selection.country)
      .then((response) => {
        if (!mounted) {
          return;
        }
        setPoints(response.data);
      })
      .catch((err) => {
        if (!mounted) {
          return;
        }
        setError(err instanceof Error ? err.message : '추세 데이터 조회 실패');
      });

    return () => {
      mounted = false;
    };
  }, [selection.appId, selection.country]);

  const trendSummary = useMemo(() => {
    if (points.length === 0) {
      return null;
    }

    const latest = points[points.length - 1];
    if (!latest) {
      return null;
    }
    const previous = points.length > 1 ? points[points.length - 2] : null;

    if (!previous) {
      return {
        message: `${latest.bucket_date} 기준 첫 데이터 포인트입니다.`,
      };
    }

    const delta = latest.total_reviews - previous.total_reviews;
    const direction = delta >= 0 ? '증가' : '감소';

    return {
      message: `${latest.bucket_date} 리뷰량은 전일 대비 ${Math.abs(delta)}건 ${direction}했습니다.`,
    };
  }, [points]);

  return (
    <section className="panel" aria-labelledby="trends-heading">
      <h2 id="trends-heading">최근 수집 일자별 추이</h2>
      {trendSummary && <p className="muted">{trendSummary.message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">날짜</th>
              <th scope="col">리뷰 수</th>
              <th scope="col">Critical</th>
              <th scope="col">평균 평점</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.bucket_date}>
                <td>{point.bucket_date}</td>
                <td>{point.total_reviews}</td>
                <td>{point.critical_count}</td>
                <td>{point.average_rating.toFixed(2)}</td>
              </tr>
            ))}
            {points.length === 0 && !error && (
              <tr>
                <td colSpan={4}>아직 표시할 데이터가 없습니다.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
