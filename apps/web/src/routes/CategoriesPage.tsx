import { useEffect, useState } from 'react';
import { getCategories } from '../lib/api';
import type { PublicCategoryPoint } from '../types';

const defaultAppId = import.meta.env.VITE_DEFAULT_APP_ID || '1018769995';
const defaultCountry = import.meta.env.VITE_DEFAULT_COUNTRY || 'kr';

export function CategoriesPage() {
  const [items, setItems] = useState<PublicCategoryPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    getCategories(defaultAppId, defaultCountry)
      .then((response) => {
        if (!mounted) {
          return;
        }
        setItems(response.data);
      })
      .catch((err) => {
        if (!mounted) {
          return;
        }
        setError(err instanceof Error ? err.message : '카테고리 통계를 불러오지 못했습니다.');
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <section className="panel" aria-labelledby="category-heading">
      <h2 id="category-heading">유형 분포</h2>
      <p className="muted">버그 / 사용성 / 칭찬 / 기타 분포를 보여줍니다.</p>
      {error && <p className="error">{error}</p>}

      <ul className="category-list" aria-live="polite">
        {items.map((item) => (
          <li key={item.category}>
            <div>
              <strong>{item.category}</strong>
              <span>{item.total_reviews}건</span>
            </div>
            <div className="progress" role="img" aria-label={`${item.category} 비율 ${item.share_percent.toFixed(1)}%`}>
              <span style={{ width: `${Math.max(4, item.share_percent)}%` }} />
            </div>
            <em>{item.share_percent.toFixed(1)}%</em>
          </li>
        ))}
        {items.length === 0 && !error && <li>아직 카테고리 통계가 없습니다.</li>}
      </ul>
    </section>
  );
}
