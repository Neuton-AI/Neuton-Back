import { AUTH_POLICY } from '../../config/auth-policy.js';
import type { AuthMailer } from './auth.ports.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';
import type { MailFailureCode, MailLease } from './mail-outbox.repository.js';

interface MailLog { info(metadata: Record<string, unknown>, message?: string): void; warn(metadata: Record<string, unknown>, message?: string): void }

export class MailDispatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private stopped = true;
  private stopping = false;

  constructor(private readonly outbox: MailOutboxRepository, private readonly mailer: AuthMailer, private readonly log: MailLog) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping = true;
    clearTimeout(this.timer);
    await this.running;
  }

  runOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void this.runOnce().catch(() => { this.log.warn({ event: 'auth_mail_dispatch_unavailable' }); })
        .finally(() => { if (!this.stopped) this.schedule(AUTH_POLICY.mail.dispatchIntervalMs); });
    }, delay);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    let claimed = 0;
    while (!this.stopping && claimed < AUTH_POLICY.mail.batchSize) {
      // Claim only immediately available capacity; a batch must not wait behind other sends until its leases expire.
      const leases = await this.outbox.claim(Math.min(AUTH_POLICY.mail.concurrency, AUTH_POLICY.mail.batchSize - claimed));
      if (leases.length === 0) return;
      claimed += leases.length;
      await Promise.all(leases.map(lease => this.deliver(lease)));
    }
  }

  private async deliver(lease: MailLease): Promise<void> {
    let renewal: Promise<void> = Promise.resolve();
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      renewal = this.outbox.extend(lease).then(owned => {
        if (!owned) this.log.warn({ event: 'auth_mail_lease_lost', mailId: lease.id });
      }).catch(() => { this.log.warn({ event: 'auth_mail_lease_unavailable', mailId: lease.id }); })
        .finally(() => { renewing = false; });
    }, AUTH_POLICY.mail.leaseMs / 3);
    heartbeat.unref();
    try {
      const message = await this.outbox.prepare(lease);
      if (!message) return;
      await this.mailer.send(message);
      if (await this.outbox.markSent(lease)) this.log.info({ event: 'auth_mail_sent', mailId: lease.id });
    } catch (error) {
      let code: MailFailureCode = 'MAIL_DELIVERY_UNAVAILABLE';
      if (error && typeof error === 'object' && 'code' in error && error.code === 'AUTH_SECRET_UNAVAILABLE') {
        code = 'AUTH_SECRET_UNAVAILABLE';
      }
      try { await this.outbox.retry(lease, code); }
      catch { this.log.warn({ event: 'auth_mail_retry_unavailable', mailId: lease.id }); }
      this.log.warn({ event: 'auth_mail_retry', mailId: lease.id, errorCode: code });
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }
  }
}
