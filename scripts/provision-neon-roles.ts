import { provisionNeonRoles } from '../src/db/provisioning.js';
import { promptMigrationUrl, provisioningFailureMessage } from '../src/db/provisioning-cli.js';

try {
  let ownerUrl = process.env.MIGRATION_DATABASE_URL?.trim();
  if (!ownerUrl) ownerUrl = await promptMigrationUrl();
  await provisionNeonRoles({ MIGRATION_DATABASE_URL: ownerUrl });
  console.log('Restricted Neuton roles provisioned. Set/reset the four LOGIN role passwords in Neon, then copy their connection strings. Existing passwords were not changed.');
} catch (error) {
  console.error(provisioningFailureMessage(error));
  process.exitCode = 1;
}
