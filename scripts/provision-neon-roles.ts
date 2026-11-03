import { provisionNeonRoles } from '../src/db/provisioning.js';

try {
  await provisionNeonRoles(process.env);
  console.log('Restricted Neuton database roles provisioned.');
} catch {
  // Driver errors may contain a password-bearing CREATE ROLE statement.
  console.error('Role provisioning failed. Check owner permissions, role-specific URLs and existing role privileges. No credentials were logged.');
  process.exitCode = 1;
}
