import { useEffect, useState } from 'react';

type Props = {
  artworkUrl: string | null;
  appName: string | null;
  size?: 'default' | 'large';
};

export function AppArtwork({ artworkUrl, appName, size = 'default' }: Props) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [artworkUrl]);

  const sizeClass = size === 'large' ? ' app-artwork--large' : '';
  if (!artworkUrl || failed) {
    return (
      <span className={`app-initial${size === 'large' ? ' app-initial--large' : ''}`} aria-hidden="true">
        {appName?.[0] || 'A'}
      </span>
    );
  }

  return (
    <img
      className={`app-artwork${sizeClass}`}
      src={artworkUrl}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
