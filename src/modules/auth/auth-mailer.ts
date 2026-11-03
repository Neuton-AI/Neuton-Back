import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { ApiAuthConfig } from '../../config/auth.js';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { AppError } from '../../lib/errors.js';
import { AuthMailer } from './auth.ports.js';
import type { AuthMailMessage } from './auth.ports.js';
import { normalizeEmail } from './normalization.js';

const messageSchema = z.object({ id: z.string().uuid(), to: z.string().max(320),
  subject: z.string().min(1).max(200).refine(value => !/[\r\n]/.test(value)), text: z.string().min(1).max(60_000) }).strict();
const unavailable = () => new AppError(503, 'MAIL_DELIVERY_UNAVAILABLE', 'Email delivery temporarily unavailable');

export class SmtpAuthMailer extends AuthMailer {
  private readonly transport;
  private readonly messageDomain: string;

  constructor(config: ApiAuthConfig['smtp'], origin: string) {
    super();
    if ((config.secure && config.port !== 465) || (!config.secure && !config.requireTLS)) throw unavailable();
    this.messageDomain = new URL(origin).hostname;
    this.transport = nodemailer.createTransport({
      host: config.host, port: config.port, secure: config.secure, requireTLS: !config.secure,
      opportunisticTLS: false, ignoreTLS: false, auth: { user: config.user, pass: config.password },
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: config.host },
      connectionTimeout: AUTH_POLICY.mail.transportTimeoutMs, greetingTimeout: AUTH_POLICY.mail.transportTimeoutMs,
      socketTimeout: AUTH_POLICY.mail.transportTimeoutMs, dnsTimeout: AUTH_POLICY.mail.transportTimeoutMs,
      disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
      logger: false, debug: false, transactionLog: false,
    }, { from: config.from });
  }

  override async send(message: AuthMailMessage): Promise<void> {
    try {
      const input = messageSchema.parse(message);
      const to = normalizeEmail(input.to).normalized;
      const result = await this.transport.sendMail({ to: { address: to, name: '' }, subject: input.subject, text: input.text,
        messageId: `<${input.id}@auth.${this.messageDomain}>`, disableFileAccess: true, disableUrlAccess: true });
      if (result.accepted.length !== 1 || result.rejected.length !== 0) throw unavailable();
    } catch {
      throw unavailable();
    }
  }

  close(): void { this.transport.close(); }
}
