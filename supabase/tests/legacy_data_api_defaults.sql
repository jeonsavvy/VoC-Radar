-- Simulate the Data API grants that existing Supabase projects applied to new
-- public objects before exposure became opt-in. The replay path removes these
-- defaults afterward; grants already attached to objects remain.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  grant usage, select on sequences to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
