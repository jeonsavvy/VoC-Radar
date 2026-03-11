create or replace view public.private_review_feed
with (security_invoker = true) as
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

revoke all on table public.private_review_feed from anon, authenticated;
grant select on table public.private_review_feed to service_role;
