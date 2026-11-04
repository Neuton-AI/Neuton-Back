export const TEST_SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_SESSION_SECRET = Buffer.alloc(32, 7).toString('base64url');
export const TEST_SESSION_COOKIE = `neuton-dev-session=${TEST_SESSION_SECRET}`;
export const testIdentity = (id: string, email: string | null = null) => ({ id, email, sessionId: TEST_SESSION_ID, status: 'active' as const });
