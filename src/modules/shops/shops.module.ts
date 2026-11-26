import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { ShopsController } from './shops.controller.js';
import { ShopsService } from './shops.service.js';
import { ShopsPersistence, SHOPS_DATABASE } from './shops.persistence.js';
import { ShopTeamController } from './shop-team.controller.js';
import { ShopTeamService } from './shop-team.service.js';
@Module({
  imports: [IdentityModule, SyncModule],
  controllers: [ShopsController, ShopTeamController],
  providers: [
    ShopsService,
    ShopTeamService,
    ShopsPersistence,
    { provide: SHOPS_DATABASE, useValue: db },
  ],
  exports: [ShopsService],
})
export class ShopsModule {}
