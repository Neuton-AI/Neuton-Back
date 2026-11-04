-- One-time initialization for the four fresh LOGIN roles created without passwords.
-- Run as the owner on the same branch. Password values are generated inside PostgreSQL,
-- never returned. Then use Neon's Reset password and copy the resulting connection strings.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'neuton_app', 'neuton_auth', 'neuton_worker', 'neuton_cleanup'
  ] LOOP
    EXECUTE format(
      'ALTER ROLE %I PASSWORD %L',
      role_name,
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    );
  END LOOP;
END $$;
