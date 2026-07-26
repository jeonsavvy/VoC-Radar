import { useRef, useState } from 'react';
import { ChevronDown, LogIn, Search, Trash2, X } from 'lucide-react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { GlobalSearch } from '@/components/GlobalSearch';
import { ApiError, deleteAccount } from '@/lib/api';

type Props = {
  loggedIn: boolean;
  userEmail?: string | null;
  onSignOut: () => void | Promise<void>;
};

type AccountDeletionPanelProps = {
  confirmation: string;
  deleting: boolean;
  accountDeleted: boolean;
  error: string | null;
  onConfirmationChange: (value: string) => void;
  onCancel: () => void;
  onDelete: () => void;
  onReload: () => void;
};

export const ACCOUNT_DELETE_CONFIRMATION = '탈퇴';

export function isAccountDeletionConfirmed(value: string) {
  return value === ACCOUNT_DELETE_CONFIRMATION;
}

export function getAccountDeletionRecoveryMessage(error: unknown) {
  if (error instanceof ApiError && error.code === 'account_delete_not_started') {
    return '계정 탈퇴를 시작하지 못했습니다. 계정과 진행 중인 분석 요청은 그대로 유지되며 작업 취소는 시작되지 않았습니다. 잠시 후 다시 시도하세요.';
  }

  if (error instanceof ApiError && error.code === 'account_delete_incomplete') {
    return '계정 삭제를 완료하지 못해 계정은 유지됩니다. 진행 중이던 분석 요청은 취소되었습니다. 잠시 후 다시 시도하세요.';
  }

  return '계정 탈퇴 결과를 확인하지 못했습니다. 새로고침해 로그인 상태를 확인하고, 계정이 남아 있으면 다시 시도하세요. 요청 내역에서 진행 중인 작업 상태도 확인할 수 있습니다.';
}

export function AccountDeletionPanel({
  confirmation,
  deleting,
  accountDeleted,
  error,
  onConfirmationChange,
  onCancel,
  onDelete,
  onReload,
}: AccountDeletionPanelProps) {
  const confirmed = isAccountDeletionConfirmed(confirmation);

  return <section id="account-delete-panel" className="account-delete-panel" aria-labelledby="account-delete-title">
    <h2 id="account-delete-title">계정 탈퇴</h2>
    <p>
      {accountDeleted ? <>
        계정 삭제는 완료됐습니다. 이 기기의 로그인 상태를 다시 확인하려면 새로고침하세요.
      </> : <>
        현재 계정과 진행 중인 분석 요청을 정리합니다. 공개 리뷰와 분석 결과는 유지됩니다.
        계속하려면 <strong>{ACCOUNT_DELETE_CONFIRMATION}</strong>를 정확히 입력하세요.
      </>}
    </p>
    {error ? <p className="account-delete-panel__error" role="alert">{error}</p> : null}
    <label>
      <span>확인 문구</span>
      <input
        type="text"
        autoComplete="off"
        value={confirmation}
        disabled={deleting || accountDeleted}
        onChange={(event) => onConfirmationChange(event.target.value)}
        placeholder={ACCOUNT_DELETE_CONFIRMATION}
      />
    </label>
    <div className="account-delete-panel__actions">
      {accountDeleted ? <button
        type="button"
        className="account-delete-panel__recovery"
        onClick={onReload}
      >
        새로고침
      </button> : <>
        <button type="button" disabled={deleting} onClick={onCancel}>취소</button>
        <button
          type="button"
          className="account-delete-panel__submit"
          disabled={!confirmed || deleting}
          aria-busy={deleting}
          onClick={onDelete}
        >
          {deleting ? '처리 중…' : '영구 탈퇴'}
        </button>
      </>}
    </div>
  </section>;
}

export function Shell({ loggedIn, userEmail, onSignOut }: Props) {
  const location = useLocation();
  const [mobileSearch, setMobileSearch] = useState(false);
  const [deletePanelOpen, setDeletePanelOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [accountDeleted, setAccountDeleted] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const deleteInFlight = useRef(false);
  const signOutInFlight = useRef(false);
  const country = location.pathname.match(/^\/apps\/([a-z]{2})\//)?.[1] || 'kr';

  const closeDeletePanel = () => {
    if (deleteInFlight.current) return;
    setDeletePanelOpen(false);
    setDeleteConfirmation('');
    setDeleteError(null);
  };

  const handleSignOut = async () => {
    if (signOutInFlight.current) return;

    signOutInFlight.current = true;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await onSignOut();
    } catch {
      setSignOutError(
        '로그아웃을 완료하지 못했습니다. 현재 화면을 유지하며, 잠시 후 다시 시도하거나 새로고침해 로그인 상태를 확인하세요.',
      );
    } finally {
      signOutInFlight.current = false;
      setSigningOut(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!isAccountDeletionConfirmed(deleteConfirmation) || deleteInFlight.current) return;

    deleteInFlight.current = true;
    setDeletingAccount(true);
    setAccountDeleted(false);
    setDeleteError(null);

    try {
      const { clearLocalSession, getAccessToken } = await import('@/lib/auth');
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setDeleteError(
          '로그인 상태를 확인하지 못했습니다. 계정은 삭제되지 않았습니다. 새로고침한 뒤 다시 로그인해 시도하세요.',
        );
        return;
      }

      await deleteAccount(accessToken);
      try {
        await clearLocalSession();
      } catch {
        setAccountDeleted(true);
        setDeleteError(
          '계정 삭제는 완료됐지만 이 기기에서 로그아웃하지 못했습니다. 새로고침해 로그인 상태를 다시 확인하세요.',
        );
        return;
      }
      window.location.assign('/');
    } catch (error) {
      setDeleteError(getAccountDeletionRecoveryMessage(error));
    } finally {
      deleteInFlight.current = false;
      setDeletingAccount(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="product-header">
        <div className="product-header__inner">
          <Link to="/" className="wordmark" aria-label="VoC Radar 홈">
            VoC Radar
          </Link>
          <div className="product-header__search">
            <GlobalSearch country={country} />
          </div>
          <nav aria-label="사용자 메뉴" className="product-header__actions">
            <button
              type="button"
              className="icon-button mobile-search-button"
              aria-label={mobileSearch ? '검색 닫기' : '앱 검색 열기'}
              onClick={() => setMobileSearch((value) => !value)}
            >
              {mobileSearch ? <X /> : <Search />}
            </button>
            {loggedIn ? (
              <details className="account-menu">
                <summary>
                  <span className="account-avatar">{userEmail?.[0]?.toUpperCase() || 'U'}</span>
                  <span className="account-label">계정</span>
                  <ChevronDown aria-hidden="true" />
                </summary>
                <div className={`account-menu__panel${deletePanelOpen ? ' account-menu__panel--delete' : ''}`}>
                  <p title={userEmail || undefined}>{userEmail || '로그인됨'}</p>
                  <NavLink to="/requests">분석 요청 내역</NavLink>
                  <button
                    type="button"
                    disabled={signingOut}
                    aria-busy={signingOut}
                    onClick={() => void handleSignOut()}
                  >
                    {signingOut ? '로그아웃 중…' : '로그아웃'}
                  </button>
                  {signOutError ? <p className="account-session-error" role="alert">{signOutError}</p> : null}
                  <button
                    type="button"
                    className="account-delete-link"
                    aria-expanded={deletePanelOpen}
                    aria-controls="account-delete-panel"
                    onClick={() => {
                      setDeletePanelOpen((value) => !value);
                      if (!accountDeleted) {
                        setDeleteConfirmation('');
                        setDeleteError(null);
                      }
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    계정 탈퇴
                  </button>
                  {deletePanelOpen ? <AccountDeletionPanel
                    confirmation={deleteConfirmation}
                    deleting={deletingAccount}
                    accountDeleted={accountDeleted}
                    error={deleteError}
                    onConfirmationChange={(value) => {
                      setDeleteConfirmation(value);
                      setDeleteError(null);
                    }}
                    onCancel={closeDeletePanel}
                    onDelete={() => void handleDeleteAccount()}
                    onReload={() => window.location.reload()}
                  /> : null}
                </div>
              </details>
            ) : (
              <Link className="login-link" to={`/login?returnTo=${encodeURIComponent(location.pathname)}`}>
                <LogIn aria-hidden="true" />
                로그인
              </Link>
            )}
          </nav>
        </div>
        {mobileSearch ? (
          <div className="mobile-search-panel">
            <GlobalSearch country={country} autoFocus onNavigate={() => setMobileSearch(false)} />
          </div>
        ) : null}
      </header>

      <main className="page-frame"><Outlet /></main>
      <footer className="product-footer">
        <span>© VoC Radar</span>
        <Link to="/privacy">개인정보처리방침</Link>
      </footer>
    </div>
  );
}
