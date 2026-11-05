import type { ApiAuthConfig } from '../../config/auth.js';
import { AuthRepository } from './auth.repository.js';
import { AccountRepository } from './account.repository.js';
import { ActionTokenRepository } from './action-token.repository.js';
import { AccountService } from './account.service.js';
import { PasswordService } from './password.service.js';
import { SessionRepository } from './session.repository.js';
import { SessionService } from './session.service.js';
import { SessionProjection } from './session-projection.js';
import type { SessionApplicationDatabase } from './session-projection.js';
import { CsrfService } from './csrf.service.js';
import { AuthRateLimits } from './rate-limit.service.js';
import { SecurityEvents } from './security-events.js';
import { AuthEncryption } from './crypto.js';
import { ArgonPasswordHasher } from './password-hasher.js';
import { MailTemplates } from './mail-templates.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';
import { GoogleProtocolClient } from './google-oidc.client.js';
import type { GoogleOidcClient } from './auth.ports.js';
import { GoogleLoginService } from './google-login.service.js';
import { OAuthRepository } from './oauth.repository.js';
import { MethodsService } from './methods.service.js';

/** Explicit collaborators let the same HTTP composition run against isolated PostgreSQL. */
export function createAuthServices(config: ApiAuthConfig, auth: AuthRepository,
  application: SessionApplicationDatabase, limits: AuthRateLimits, protocol: GoogleOidcClient = new GoogleProtocolClient(config.google)) {
  const accounts = new AccountRepository(auth);
  const actions = new ActionTokenRepository(auth);
  const sessions = new SessionRepository(auth);
  const events = new SecurityEvents();
  const hasher = new ArgonPasswordHasher();
  const encryption = new AuthEncryption(config.encryption.activeKeyId, config.encryption.keys);
  const outbox = new MailOutboxRepository(auth, encryption, new MailTemplates(config.origin));
  const oauth = new OAuthRepository(auth, encryption, config.environment);
  const csrf = new CsrfService(auth, sessions, config);
  return { config, auth, accounts, actions, sessions, events, outbox, csrf, limits,
    methods: new MethodsService(auth, sessions, hasher, outbox, events, limits),
    google: new GoogleLoginService(auth, oauth, sessions, protocol, limits, accounts, actions, outbox, events, config.origin),
    accountService: new AccountService(auth, accounts, actions, outbox, hasher, limits, events, sessions),
    passwords: new PasswordService(auth, accounts, sessions, hasher, limits, events, outbox, actions),
    sessionService: new SessionService(sessions, events), projection: new SessionProjection(accounts, sessions, application, config.environment) };
}
export type AuthServices = ReturnType<typeof createAuthServices>;
