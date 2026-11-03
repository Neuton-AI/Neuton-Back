import type { ActionPurpose } from './action-token.repository.js';
import { isBearerSecret } from './normalization.js';

export type SecurityNotice = 'password_changed' | 'password_reset' | 'password_added' | 'google_linked' |
  'google_unlinked' | 'email_changed' | 'sessions_revoked' | 'account_disabled';
export interface MailContent { subject: string; text: string }
const actionPages: Record<ActionPurpose, { path: string; subject: string; instruction: string }> = {
  confirm_email: { path: '/auth/confirm', subject: 'Confirm your Neuton email', instruction: 'Confirm your email address to activate your Neuton account.' },
  password_reset: { path: '/auth/reset-password', subject: 'Reset your Neuton password', instruction: 'Choose a new password for your Neuton account.' },
  email_change: { path: '/auth/email-change', subject: 'Confirm your new Neuton email', instruction: 'Confirm this address as the new email for your Neuton account.' },
};
const notices: Record<SecurityNotice, string> = {
  password_changed: 'Your Neuton password was changed.', password_reset: 'Your Neuton password was reset.',
  password_added: 'A password was added to your Neuton account.', google_linked: 'Google sign-in was linked to your Neuton account.',
  google_unlinked: 'Google sign-in was removed from your Neuton account.', email_changed: 'Your Neuton contact email was changed.',
  sessions_revoked: 'Your Neuton sessions were revoked.', account_disabled: 'Your Neuton account was disabled.',
};

export class MailTemplates {
  constructor(private readonly origin: string) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
      throw new Error('Exact application origin required');
    }
  }

  action(purpose: ActionPurpose, secret: string): MailContent {
    if (!isBearerSecret(secret)) throw new Error('Valid action secret required');
    const page = actionPages[purpose];
    const url = new URL(page.path, this.origin);
    url.hash = 'token=' + secret;
    return { subject: page.subject, text: `${page.instruction}\n\n${url.href}\n\n` +
      'Open the link and submit the form to complete this action. The link expires and can be used once.\n' +
      'If you did not request this, you can ignore this email.' };
  }

  notice(notice: SecurityNotice): MailContent {
    return { subject: 'Neuton account security notice', text: `${notices[notice]}\n\n` +
      'If you did not make this change, secure your account using the normal sign-in and password recovery pages.' };
  }
}
