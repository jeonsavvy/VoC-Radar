-- The unified Worker is the only public HTTP boundary. These legacy read RPCs
-- still back Worker compatibility paths, but browser roles must not bypass the
-- Worker's validation, cache, rate-limit, and response-shaping contract.

revoke execute on function public.get_public_categories(text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.get_public_issues(text, text, timestamptz, timestamptz, integer)
  from public, anon, authenticated;
revoke execute on function public.get_public_overview(text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.get_public_trends(text, text, timestamptz, timestamptz)
  from public, anon, authenticated;

grant execute on function public.get_public_categories(text, text, timestamptz, timestamptz)
  to service_role;
grant execute on function public.get_public_issues(text, text, timestamptz, timestamptz, integer)
  to service_role;
grant execute on function public.get_public_overview(text, text, timestamptz, timestamptz)
  to service_role;
grant execute on function public.get_public_trends(text, text, timestamptz, timestamptz)
  to service_role;
