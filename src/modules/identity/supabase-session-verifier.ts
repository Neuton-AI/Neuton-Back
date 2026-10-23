import type { SupabaseClient } from '@supabase/supabase-js';
import { SessionVerifier } from './identity.ports.js';

export class SupabaseSessionVerifier extends SessionVerifier {
  constructor(private readonly client: SupabaseClient) { super(); }

  override async verify(token: string) {
    const { data, error } = await this.client.auth.getUser(token);
    if (error || !data.user || typeof data.user.id !== 'string' || !data.user.id) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  }
}
