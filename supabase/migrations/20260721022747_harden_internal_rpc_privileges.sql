-- Pipeline control RPCs use SECURITY DEFINER because only the service-role
-- Worker/n8n boundary may bypass RLS. Keep them out of the public Data API.
revoke execute on function public.get_existing_review_ids(text, text, text[])
  from public, anon, authenticated;
revoke execute on function public.claim_pipeline_job(text, text, text)
  from public, anon, authenticated;
revoke execute on function public.complete_pipeline_job(uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.get_existing_review_ids(text, text, text[])
  to service_role;
grant execute on function public.claim_pipeline_job(text, text, text)
  to service_role;
grant execute on function public.complete_pipeline_job(uuid, text, text, text)
  to service_role;

-- Supabase may install this event-trigger helper outside the repository. It
-- does not need to be callable through PostgREST, including by service_role.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated, service_role';
  end if;
end;
$$;

-- PostgreSQL does not automatically index the referencing side of foreign
-- keys. These indexes cover review deletion and run deletion/pointer lookups.
create index if not exists idx_issue_cluster_reviews_review
  on public.issue_cluster_reviews (review_id);

create index if not exists idx_issue_clusters_current_run
  on public.issue_clusters (current_run_id);
