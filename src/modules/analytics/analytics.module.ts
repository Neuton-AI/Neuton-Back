import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import {
  AnalyticsPersistence,
  ANALYTICS_DEPS,
} from './analytics.persistence.js';
@Module({
  imports: [IdentityModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsPersistence,
    { provide: ANALYTICS_DEPS, useValue: { db, now: () => new Date() } },
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
