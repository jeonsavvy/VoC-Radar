import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';

const PRIVACY_SECTIONS = [
  {
    title: '1. 처리하는 개인정보 항목',
    body: [
      '로그인 및 분석 요청 권한 확인을 위해 이메일 주소, 인증 식별자, 로그인 세션 정보를 처리합니다.',
      '분석 요청 이력 관리를 위해 App Store ID, 국가 코드, 요청 시각, 실행 상태, 오류 메시지, 요청 계정 식별자를 처리합니다.',
      '서비스가 분석 대상으로 삼는 App Store 공개 리뷰의 작성자명, 평점, 작성일, 리뷰 본문, 분석 결과를 저장·표시할 수 있습니다.',
    ],
  },
  {
    title: '2. 개인정보의 처리 목적',
    body: [
      '회원 인증, 신규·갱신 분석 요청, 사용자별 요청 이력 조회에 사용합니다.',
      'App Store 리뷰 수집, 중복 제거, 구조화 추출과 이슈 군집화, 공개 리포트 제공에 사용합니다.',
      '오류 대응, 서비스 안정성 확인, 부정 이용 방지 및 보안 점검에 사용합니다.',
    ],
  },
  {
    title: '3. 보유 및 이용 기간',
    body: [
      '계정 정보는 회원 탈퇴 또는 서비스 이용 종료 요청 시까지 보관합니다.',
      '분석 요청 이력과 분석 데이터는 서비스 운영 및 분석 이력 보존에 필요한 기간 동안 보관하며, 목적 달성 또는 삭제 요청 시 지체 없이 파기합니다.',
      '법령상 보존 의무가 있는 경우 해당 기간 동안 별도 보관할 수 있습니다.',
    ],
  },
  {
    title: '4. 제3자 제공 및 처리위탁',
    body: [
      '서비스 제공을 위해 Supabase, Cloudflare, n8n 및 분석 자동화 도구를 사용할 수 있습니다.',
      '법령에 근거가 있거나 이용자의 동의가 있는 경우를 제외하고 개인정보를 외부에 판매하거나 목적 외로 제공하지 않습니다.',
    ],
  },
  {
    title: '5. 정보주체의 권리',
    body: [
      '이용자는 개인정보 열람, 정정, 삭제, 처리정지를 요청할 수 있습니다.',
      '요청은 아래 개인정보 문의 이메일로 접수하며, 본인 확인 후 관련 법령에 따라 처리합니다.',
    ],
  },
  {
    title: '6. 안전성 확보 조치',
    body: [
      '인증이 필요한 기능은 Supabase Auth access token을 확인한 뒤 제공하며, 서버 전용 키와 운영 비밀값은 브라우저에 노출하지 않습니다.',
      '내부 파이프라인 API는 별도 토큰과 서명 검증으로 보호하고, 불필요한 접근 권한을 제한합니다.',
    ],
  },
] as const;

export function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[960px] flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link to="/" className="inline-flex items-center gap-3 text-foreground">
            <span className="text-base font-semibold tracking-tight">VoC Radar</span>
          </Link>
          <Link
            to="/"
            className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-accent"
          >
            앱 탐색으로 돌아가기
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[960px] space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <PageHeader title="개인정보처리방침" />

        <Card>
          <CardHeader>
            <CardTitle>기본 정보</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 px-6 pb-6 pt-4 text-sm text-muted-foreground sm:grid-cols-[repeat(3,max-content)] sm:gap-x-12">
            <div>
              <p className="font-semibold text-foreground">개인정보처리자</p>
              <p className="mt-1">전찬혁</p>
            </div>
            <div>
              <p className="font-semibold text-foreground">개인정보 문의</p>
              <p className="mt-1">jeonsavvy@gmail.com</p>
            </div>
            <div>
              <p className="font-semibold text-foreground">시행일</p>
              <p className="mt-1">2026년 3월 1일</p>
            </div>
          </CardContent>
        </Card>

        {PRIVACY_SECTIONS.map((section) => (
          <Card key={section.title}>
            <CardHeader>
              <CardTitle>{section.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-2 pl-5 text-sm leading-7 text-muted-foreground">
                {section.body.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </main>

      <footer className="mx-auto flex w-full max-w-[960px] flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 pb-8 text-center text-sm text-muted-foreground sm:px-6">
        <span>© VoC Radar</span>
        <Link to="/" className="font-medium underline-offset-4 hover:text-foreground hover:underline">
          앱 탐색
        </Link>
      </footer>
    </div>
  );
}
