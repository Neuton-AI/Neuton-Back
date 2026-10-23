import { Controller, Get, Module } from '@nestjs/common';
import { createHttpApplication, type HttpOptions } from './http/application.js';
import { env, corsOrigins } from './env.js';
import { LoggerImpl } from './lib/logger/index.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { ReceiptsModule } from './modules/receipts/receipts.module.js';
import { UploadsModule } from './modules/uploads/uploads.module.js';
import { ShopsModule } from './modules/shops/shops.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { SyncModule } from './modules/sync/sync.module.js';
@Controller()
class HealthController {
  @Get('health') health() {
    return { ok: true, service: 'neuton-api' };
  }
}
@Module({
  imports: [
    IdentityModule,
    CatalogModule,
    OrdersModule,
    ReceiptsModule,
    UploadsModule,
    ShopsModule,
    AnalyticsModule,
    SyncModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
export interface BuildAppOptions {
  logger?: boolean;
  http?: Partial<HttpOptions>;
}
export function buildApp(options: BuildAppOptions = {}) {
  return createHttpApplication(AppModule, {
    origins: corsOrigins,
    bodyLimit: env.MAX_UPLOAD_BYTES,
    rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW },
    trustProxy: env.TRUST_PROXY,
    ...(options.logger === false
      ? { logger: new LoggerImpl({ write: () => {} }, {}, null) }
      : {}),
    ...options.http,
  });
}
