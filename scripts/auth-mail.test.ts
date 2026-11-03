import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MailTemplates } from '../src/modules/auth/mail-templates.js';
import { SmtpAuthMailer } from '../src/modules/auth/auth-mailer.js';
import { newSecret } from '../src/modules/auth/crypto.js';

test('action templates use only fixed application pages and fragment secrets', () => {
  const templates = new MailTemplates('https://neuton.example');
  const secret = newSecret();
  for (const [purpose, path] of [['confirm_email', '/auth/confirm'], ['password_reset', '/auth/reset-password'],
    ['email_change', '/auth/email-change']] as const) {
    const message = templates.action(purpose, secret);
    const link = new URL(message.text.match(/https:\/\/\S+/)![0]);
    assert.equal(link.origin, 'https://neuton.example');
    assert.equal(link.pathname, path);
    assert.equal(link.search, '');
    assert.equal(link.hash, '#token=' + secret);
  }
  assert.equal(templates.notice('password_changed').text.includes('#token='), false);
  assert.throws(() => templates.action('password_reset', 'malformed'));
  assert.throws(() => new MailTemplates('https://example.com/redirect'));
  assert.throws(() => new MailTemplates('http://remote.example'));
});

test('SMTP refuses plaintext delivery and never logs or exposes the protocol failure', async () => {
  const commands: string[] = [];
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    socket.write('220 synthetic SMTP\r\n');
    let buffered = '';
    socket.on('data', data => {
      buffered += data;
      const lines = buffered.split('\r\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250-synthetic\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('STARTTLS')) socket.write('502 private-server-detail\r\n');
        else socket.write('500 unexpected command\r\n');
      }
    });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const mailer = new SmtpAuthMailer({ host: '127.0.0.1', port: address.port, secure: false, requireTLS: true,
    user: 'synthetic-user', password: 'synthetic-password', from: 'Neuton <noreply@example.com>' }, 'https://neuton.example');
  try {
    await assert.rejects(mailer.send({ id: randomUUID(), to: 'synthetic@example.com', subject: 'Subject', text: 'private message' }), {
      code: 'MAIL_DELIVERY_UNAVAILABLE', message: 'Email delivery temporarily unavailable',
    });
    assert.ok(commands.some(command => command.startsWith('STARTTLS')));
    assert.equal(commands.some(command => /^(AUTH|MAIL|RCPT|DATA)/.test(command)), false);
  } finally {
    mailer.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
