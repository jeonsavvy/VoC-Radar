import { useEffect, useState } from 'react';
import { getPublicArtworkUrl } from '@/lib/api';

type Props = {
  artworkUrl: string | null;
  appName: string | null;
  appStoreId?: string;
  country?: string;
  size?: 'default' | 'large';
};

export function getArtworkSources({
  artworkUrl,
  appStoreId,
  country,
}: Pick<Props, 'artworkUrl' | 'appStoreId' | 'country'>) {
  const directSource = artworkUrl?.trim() || null;
  const proxySources = appStoreId
    ? [
        getPublicArtworkUrl(appStoreId, country, 0),
        getPublicArtworkUrl(appStoreId, country, 1),
      ]
    : [];
  return [directSource, ...proxySources].filter(
    (source, index, sources): source is string => Boolean(source) && sources.indexOf(source) === index,
  );
}

export function AppArtwork({ artworkUrl, appName, appStoreId, country, size = 'default' }: Props) {
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [artworkUrl, appStoreId, country]);

  const sources = getArtworkSources({ artworkUrl, appStoreId, country });
  const currentSource = sources[sourceIndex] || null;
  const sizeClass = size === 'large' ? ' app-artwork--large' : '';
  if (!currentSource) {
    return (
      <span className={`app-initial${size === 'large' ? ' app-initial--large' : ''}`} aria-hidden="true">
        {appName?.[0] || 'A'}
      </span>
    );
  }

  return (
    <img
      className={`app-artwork${sizeClass}`}
      src={currentSource}
      alt=""
      loading="lazy"
      onError={() => setSourceIndex((index) => index + 1)}
    />
  );
}
