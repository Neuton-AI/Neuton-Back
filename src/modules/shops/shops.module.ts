import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { supabaseAdmin } from '../../lib/supabase-admin.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ShopsController } from './shops.controller.js';
import { ShopsService } from './shops.service.js';
import { ShopsPersistence, SHOPS_DATABASE } from './shops.persistence.js';
import { PasswordService, PASSWORD_CLIENT } from './password.service.js';
@Module({
  imports: [IdentityModule],
  controllers: [ShopsController],
  providers: [
    ShopsService,
    ShopsPersistence,
    PasswordService,
    { provide: SHOPS_DATABASE, useValue: db },
    { provide: PASSWORD_CLIENT, useValue: supabaseAdmin },
  ],
  exports: [ShopsService],
})
export class ShopsModule {}
