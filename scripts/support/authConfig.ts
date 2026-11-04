import { readAuthConfig } from '../../src/config/auth.js';

export function syntheticAuthConfig() {
  const url = (role: string) => `postgresql://${role}:synthetic@db.example/neuton?sslmode=require`;
  return readAuthConfig('api', { NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: url('neuton_app'), AUTH_DATABASE_URL: url('neuton_auth'), CLEANUP_DATABASE_URL: url('neuton_cleanup'),
    DATABASE_LISTEN_URL: url('neuton_app'), GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'synthetic',
    GOOGLE_REDIRECT_URI: 'http://localhost:5173/api/v1/auth/google/callback', SMTP_HOST: 'smtp.example', SMTP_PORT: '587', SMTP_SECURE: 'false',
    SMTP_USER: 'synthetic', SMTP_PASSWORD: 'synthetic', MAIL_FROM: 'Neuton <noreply@example.com>', AUTH_ENCRYPTION_ACTIVE_KEY_ID: 'synthetic',
    AUTH_ENCRYPTION_KEYS: JSON.stringify({ synthetic: Buffer.alloc(32, 11).toString('base64') }), AUTH_RATE_LIMIT_SECRET: Buffer.alloc(32, 31).toString('base64') });
}
