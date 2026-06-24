-- WMS — Migration 0011: DOWN
-- Reverts the explicit API-role grants. (RLS policies are untouched.)
begin;

alter default privileges in schema public
  revoke select, insert, update, delete on tables from authenticated;
alter default privileges in schema public
  revoke usage, select on sequences from authenticated;
alter default privileges in schema public
  revoke execute on functions from authenticated;

revoke execute on all functions in schema public from authenticated;
revoke usage, select on all sequences in schema public from authenticated;
revoke insert, update, delete on all tables in schema public from authenticated;
revoke select on all tables in schema public from authenticated;

commit;
