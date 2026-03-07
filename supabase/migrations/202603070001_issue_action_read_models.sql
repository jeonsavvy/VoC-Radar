create or replace function public.normalize_review_category(
  p_category text,
  p_summary text default '',
  p_content text default ''
)
returns text
language sql
immutable
set search_path = public
as $$
  with src as (
    select lower(concat_ws(' ', coalesce(p_category, ''), coalesce(p_summary, ''), coalesce(p_content, ''))) as source
  )
  select case
    when source ~ '(버그|오류|에러|튕|크래시|멈춤|먹통|작동.?안|실행.?안|느림|지연|렉|버벅|속도|발열|배터리|프리징|로딩|lag|slow|performance|stability|bug|error|crash|fail)' then '버그 및 성능'
    when source ~ '(결제|구독|환불|인앱|구매|billing|payment|subscription|refund|로그인|log in|login|계정|인증|회원가입|가입|account|auth|sign in|sign-in|signin)' then '계정 및 결제'
    when source ~ '(콘텐츠|커뮤니티|운영|정책|약관|규정|신고|정지|제재|차단|검수|게시글|피드|노출|알림|고객센터|문의|응대|content|community|policy|moderation|report|ban|suspend|support)' then '콘텐츠 및 운영 정책'
    when source ~ '(사용성|불편|ui|ux|디자인|가독성|동선|메뉴|접근성|편의|요청|기능.?추가|추가해|개선해|지원해|원해|feature request|please add|wish)' then '기능 및 사용성'
    when source ~ '(칭찬|좋아|좋음|최고|만족|감사|추천|great|love|excellent|awesome)' then '긍정 리뷰 및 기타'
    else '긍정 리뷰 및 기타'
  end
  from src;
$$;

alter table public.review_ai
  add column if not exists issue_label text,
  add column if not exists reason_summary text,
  add column if not exists action_hint text;

update public.review_ai ai
set
  priority = case
    when lower(replace(replace(replace(coalesce(ai.priority, ''), '🚨', ''), '⚠️', ''), '✅', '')) like '%critical%' then 'Critical'
    when lower(replace(replace(replace(coalesce(ai.priority, ''), '🚨', ''), '⚠️', ''), '✅', '')) like '%high%' then 'High'
    else 'Normal'
  end,
  category = public.normalize_review_category(ai.category, ai.summary, r.content),
  issue_label = coalesce(
    nullif(trim(ai.issue_label), ''),
    case public.normalize_review_category(ai.category, ai.summary, r.content)
      when '버그 및 성능' then '성능/안정성 점검'
      when '계정 및 결제' then '계정/결제 불편'
      when '콘텐츠 및 운영 정책' then '운영 정책 확인'
      when '기능 및 사용성' then '사용성 개선'
      else '긍정/기타 확인'
    end
  ),
  reason_summary = coalesce(nullif(trim(ai.reason_summary), ''), nullif(trim(ai.summary), ''), '원인 요약 없음'),
  action_hint = coalesce(
    nullif(trim(ai.action_hint), ''),
    case public.normalize_review_category(ai.category, ai.summary, r.content)
      when '버그 및 성능' then '오류 재현 후 안정화 우선순위를 확인하세요.'
      when '계정 및 결제' then '로그인·결제 흐름과 고객 문의 로그를 함께 점검하세요.'
      when '콘텐츠 및 운영 정책' then '정책/운영 공지와 실제 사용자 불만 포인트를 함께 확인하세요.'
      when '기능 및 사용성' then '불편 구간을 정의하고 개선안 우선순위를 정리하세요.'
      else '긍정 피드백과 일반 의견을 분리해 다음 개선 후보로 보관하세요.'
    end
  ),
  updated_at = now()
from public.reviews r
where r.review_id = ai.review_id;

alter table public.review_ai
  drop constraint if exists review_ai_priority_check;

alter table public.review_ai
  add constraint review_ai_priority_check
  check (priority in ('Critical', 'High', 'Normal'));

alter table public.review_ai
  drop constraint if exists review_ai_category_check;

alter table public.review_ai
  add constraint review_ai_category_check
  check (category in ('버그 및 성능', '계정 및 결제', '콘텐츠 및 운영 정책', '기능 및 사용성', '긍정 리뷰 및 기타'));

create or replace view public.private_review_feed as
select
  r.review_id,
  r.app_store_id,
  r.country,
  r.rating,
  r.author,
  r.content,
  r.reviewed_at,
  ai.priority,
  public.normalize_review_category(ai.category, ai.summary, r.content) as category,
  ai.summary,
  ai.confidence,
  coalesce(nullif(trim(ai.issue_label), ''), public.normalize_review_category(ai.category, ai.summary, r.content)) as issue_label,
  coalesce(nullif(trim(ai.reason_summary), ''), ai.summary) as reason_summary,
  coalesce(nullif(trim(ai.action_hint), ''), '후속 조치가 필요합니다.') as action_hint
from public.reviews r
join public.review_ai ai using (review_id);

revoke all on table public.private_review_feed from anon;
grant select on table public.private_review_feed to authenticated;

create or replace function public.get_public_issues(
  p_app_store_id text,
  p_country text default 'kr',
  p_from timestamptz default now() - interval '30 days',
  p_to timestamptz default now(),
  p_limit integer default 10
)
returns table (
  issue_label text,
  category text,
  review_count bigint,
  critical_count bigint,
  low_rating_count bigint,
  average_rating numeric,
  last_review_at timestamptz,
  previous_review_count bigint,
  change_percent numeric,
  reason_summary text,
  action_hint text
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select
      coalesce(p_from, now() - interval '30 days') as from_at,
      coalesce(p_to, now()) as to_at,
      greatest(coalesce(p_limit, 10), 1) as row_limit
  ),
  current_rows as (
    select
      coalesce(nullif(trim(ai.issue_label), ''), public.normalize_review_category(ai.category, ai.summary, r.content)) as issue_label,
      public.normalize_review_category(ai.category, ai.summary, r.content) as category,
      ai.priority,
      r.rating,
      r.reviewed_at,
      coalesce(nullif(trim(ai.reason_summary), ''), ai.summary) as reason_summary,
      coalesce(nullif(trim(ai.action_hint), ''), '후속 조치가 필요합니다.') as action_hint
    from public.reviews r
    join public.review_ai ai using (review_id)
    cross join params
    where r.app_store_id = p_app_store_id
      and r.country = p_country
      and r.reviewed_at >= params.from_at
      and r.reviewed_at <= params.to_at
  ),
  previous_rows as (
    select
      coalesce(nullif(trim(ai.issue_label), ''), public.normalize_review_category(ai.category, ai.summary, r.content)) as issue_label
    from public.reviews r
    join public.review_ai ai using (review_id)
    cross join params
    where r.app_store_id = p_app_store_id
      and r.country = p_country
      and r.reviewed_at >= params.from_at - (params.to_at - params.from_at)
      and r.reviewed_at < params.from_at
  ),
  previous_counts as (
    select issue_label, count(*)::bigint as previous_review_count
    from previous_rows
    group by issue_label
  ),
  ranked_reasons as (
    select
      issue_label,
      category,
      reason_summary,
      action_hint,
      row_number() over (
        partition by issue_label
        order by reviewed_at desc
      ) as row_number
    from current_rows
  ),
  merged as (
    select
      current_rows.issue_label,
      min(current_rows.category) as category,
      count(*)::bigint as review_count,
      count(*) filter (where current_rows.rating <= 2)::bigint as low_rating_count,
      count(*) filter (
        where current_rows.priority = 'Critical'
          or (
            current_rows.rating = 1
            and current_rows.category in ('버그 및 성능', '계정 및 결제')
          )
      )::bigint as critical_count,
      coalesce(avg(current_rows.rating::numeric), 0)::numeric(5,2) as average_rating,
      max(current_rows.reviewed_at) as last_review_at,
      coalesce(previous_counts.previous_review_count, 0)::bigint as previous_review_count
    from current_rows
    left join previous_counts on previous_counts.issue_label = current_rows.issue_label
    group by current_rows.issue_label, previous_counts.previous_review_count
  )
  select
    merged.issue_label,
    merged.category,
    merged.review_count,
    merged.critical_count,
    merged.low_rating_count,
    merged.average_rating,
    merged.last_review_at,
    merged.previous_review_count,
    case
      when merged.previous_review_count = 0 then null
      else round(((merged.review_count - merged.previous_review_count)::numeric / merged.previous_review_count::numeric) * 100, 1)
    end as change_percent,
    ranked_reasons.reason_summary,
    ranked_reasons.action_hint
  from merged
  left join ranked_reasons
    on ranked_reasons.issue_label = merged.issue_label
   and ranked_reasons.row_number = 1
  order by merged.critical_count desc, merged.low_rating_count desc, merged.review_count desc, merged.last_review_at desc
  limit (select row_limit from params);
$$;

grant execute on function public.get_public_issues(text, text, timestamptz, timestamptz, integer) to anon, authenticated;
