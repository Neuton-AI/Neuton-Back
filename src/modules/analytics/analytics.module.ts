import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import {
  AnalyticsPersistence,
  ANALYTICS_DEPS,
  defaultAnalyticsDeps,
} from './analytics.persistence.js';
@Module({
  imports: [IdentityModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsPersistence,
    { provide: ANALYTICS_DEPS, useValue: defaultAnalyticsDeps },
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
