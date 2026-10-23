import { Inject, Injectable } from '@nestjs/common';
import { supabaseAdmin } from '../../lib/supabase-admin.js';
import { badRequest } from '../../lib/errors.js';
export const PASSWORD_CLIENT = Symbol('PASSWORD_CLIENT');
export type PasswordClient = Pick<typeof supabaseAdmin, 'auth'>;
@Injectable()
export class PasswordService {
  constructor(
    @Inject(PASSWORD_CLIENT)
    private readonly client: PasswordClient = supabaseAdmin,
  ) {}
  async change(
    user: { id: string; email: string | null },
    input: { currentPassword: string; newPassword: string },
  ) {
    const { data, error } = await this.client.auth.signInWithPassword({
      email: user.email ?? '',
      password: input.currentPassword,
    });
    if (error || !data.user || data.user.id !== user.id)
      throw badRequest('Current password is incorrect');
    const { error: updateError } = await this.client.auth.admin.updateUserById(
      user.id,
      { password: input.newPassword },
    );
    if (updateError) throw badRequest('Password could not be updated');
    return { ok: true as const };
  }
}
