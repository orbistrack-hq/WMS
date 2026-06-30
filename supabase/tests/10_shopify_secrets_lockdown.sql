-- Secrets are sealed from the API role; the UI sees only booleans.
begin;
select plan(5);

-- The status view exposes setup booleans...
select has_column('public', 'store_credential_status', 'has_token',
  'status view exposes has_token');
select has_column('public', 'store_credential_status', 'has_secret',
  'status view exposes has_secret');

-- ...and never the raw secret values.
select hasnt_column('public', 'store_credential_status', 'access_token',
  'status view does not expose access_token');
select hasnt_column('public', 'store_credential_status', 'api_secret',
  'status view does not expose api_secret');

-- The authenticated (API) role cannot read the secrets table at all.
set role authenticated;
select throws_ok(
  $$ select 1 from public.store_secrets $$,
  '42501', NULL,
  'authenticated cannot read store_secrets (table is sealed)');
reset role;

select * from finish();
rollback;
