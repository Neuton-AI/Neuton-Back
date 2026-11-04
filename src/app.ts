import { Controller, Get, Module } from '@nestjs/common';
import { createHttpApplication, type HttpOptions } from './http/application.js';
import { env } from './env.js';
import { LoggerImpl, apiLogger } from './lib/logger/index.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { readAuthConfig, readBrowserConfig } from './config/auth.js';
import { db } from './db/client.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { RecipeModule } from './modules/recipes/recipe.module.js';
import { CategoriesModule } from './modules/categories/categories.module.js';
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
    InventoryModule,
    RecipeModule,
    CategoriesModule,
    OrdersModule,
    ReceiptsModule,
    UploadsModule,
    ShopsModule,
    AnalyticsModule,
    SyncModule,
  ],
  controllers: [HealthController],
})
export class BusinessModule {}
@Module({ imports: [BusinessModule, AuthModule.forRoot(() => readAuthConfig('api'), apiLogger, env.UPSTASH_REDIS_URL, db)] })
export class AppModule {}
export interface BuildAppOptions {
  logger?: boolean;
  http?: Partial<HttpOptions>;
}
export function buildApp(options: BuildAppOptions = {}) {
  const browser = readBrowserConfig();
  return createHttpApplication(AppModule, {
    origins: [browser.origin], authOrigin: browser.origin,
    bodyLimit: env.MAX_UPLOAD_BYTES,
    rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW },
    trustProxy: env.TRUST_PROXY,
    ...(options.logger === false
      ? { logger: new LoggerImpl({ write: () => {} }, {}, null) }
      : {}),
    ...options.http,
  });
}
