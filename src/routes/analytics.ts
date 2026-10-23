import type {FastifyPluginAsync,FastifyRequest} from 'fastify';import {currentShop,currentUser,currentRole} from '../plugins/auth.js';
import {AnalyticsService} from '../modules/analytics/analytics.service.js';import {AnalyticsPersistence,defaultAnalyticsDeps,type AnalyticsDeps} from '../modules/analytics/analytics.persistence.js';import {dashboardSchema,recentSchema} from '../modules/analytics/contracts.js';
export * from '../modules/analytics/analytics.persistence.js';
declare module 'fastify' {interface FastifyRequest {analyticsDeps?:AnalyticsDeps;}}
const service=(r:FastifyRequest)=>new AnalyticsService(new AnalyticsPersistence(r.analyticsDeps??defaultAnalyticsDeps));
const actor=(r:FastifyRequest)=>({user:currentUser(r),shop:currentShop(r),role:currentRole(r),requestId:r.id,traceId:r.traceId??r.id,log:r.log});
export const analyticsRoutes:FastifyPluginAsync=async app=>{const guards={preHandler:[app.authenticate,app.resolveShop]};
 app.get('/analytics/dashboard',guards,async r=>service(r).dashboard(actor(r),dashboardSchema.parse(r.query).period));
 app.get('/analytics/recent-orders',guards,async r=>service(r).recent(actor(r),recentSchema.parse(r.query).limit));
 app.get('/analytics/inventory-value',guards,async r=>service(r).inventoryValue(actor(r)));
};
