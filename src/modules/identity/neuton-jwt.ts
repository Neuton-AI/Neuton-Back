import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { SessionVerifier } from './identity.ports.js';

const algorithm = 'HS256';
const issuer = 'neuton';
const audience = 'neuton-api';
const tokenLifetimeSeconds = 60 * 60;
const subjectSchema = z.string().uuid();

export class NeutonJwt extends SessionVerifier {
  constructor(private readonly key: Uint8Array) {
    super();
  }

  issue(user: { id: string; email: string }) {
    return new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: algorithm, typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${tokenLifetimeSeconds}s`)
      .sign(this.key);
  }

  override async verify(token: string) {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [algorithm],
        issuer,
        audience,
        typ: 'JWT',
        requiredClaims: ['sub', 'iat', 'exp', 'email'],
      });
      const subject = subjectSchema.safeParse(payload.sub);
      if (!subject.success || typeof payload.email !== 'string') return null;
      return { id: subject.data, email: payload.email };
    } catch (error) {
      if (error instanceof errors.JOSEError) return null;
      throw error;
    }
  }
}
