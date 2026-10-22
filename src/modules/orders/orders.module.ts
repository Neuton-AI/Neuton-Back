import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrdersController } from './orders.controller.js';
import { ORDERS_DATABASE, OrdersPersistence } from './orders.persistence.js';
import { OrdersService } from './orders.service.js';
import { OrdersAudit } from './orders.audit.js';
@Module({
  imports: [IdentityModule],
  controllers: [OrdersController],
  providers: [
    { provide: ORDERS_DATABASE, useValue: db }, OrdersPersistence, OrdersService, OrdersAudit,
  ],
  exports: [OrdersService, OrdersPersistence],
})
export class OrdersModule {}
