create role anon;
create role authenticated;
create role service_role bypassrls;

create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid()
returns uuid
language sql
stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
