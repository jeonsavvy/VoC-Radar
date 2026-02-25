import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { getPrivateReviews } from '../lib/api';
import { getAccessToken } from '../lib/auth';
import type { PrivateReviewItem } from '../types';

type Props = {
  loggedIn: boolean;
};

const defaultAppId = import.meta.env.VITE_DEFAULT_APP_ID || '1018769995';
const defaultCountry = import.meta.env.VITE_DEFAULT_COUNTRY || 'kr';

export function ReviewsPage({ loggedIn }: Props) {
  const [items, setItems] = useState<PrivateReviewItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) {
          throw new Error('인증 토큰을 찾을 수 없습니다. 다시 로그인하세요.');
        }

        const response = await getPrivateReviews(defaultAppId, token, defaultCountry);
        if (!mounted) {
          return;
        }
        setItems(response.data);
      } catch (err) {
        if (!mounted) {
          return;
        }
        setError(err instanceof Error ? err.message : '리뷰 상세 조회 실패');
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      mounted = false;
    };
  }, []);

  if (!loggedIn) {
    return <Navigate to="/login" replace />;
  }

  return (
    <section className="panel" aria-labelledby="review-heading">
      <h2 id="review-heading">상세 리뷰 (인증 사용자 전용)</h2>

      {loading && <p>불러오는 중...</p>}
      {error && <p className="error">{error}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">작성일</th>
              <th scope="col">작성자</th>
              <th scope="col">별점</th>
              <th scope="col">우선순위</th>
              <th scope="col">유형</th>
              <th scope="col">요약</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.review_id}>
                <td>{new Date(item.reviewed_at).toLocaleDateString()}</td>
                <td>{item.author}</td>
                <td>{item.rating}</td>
                <td>{item.priority}</td>
                <td>{item.category}</td>
                <td>{item.summary}</td>
              </tr>
            ))}
            {!loading && items.length === 0 && !error && (
              <tr>
                <td colSpan={6}>조회된 리뷰가 없습니다.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
