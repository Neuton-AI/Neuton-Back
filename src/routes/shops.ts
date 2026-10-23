import type {FastifyPluginAsync,FastifyRequest} from 'fastify';
import {currentUser,currentShop,currentRole} from '../plugins/auth.js';
import {ShopsService} from '../modules/shops/shops.service.js';import {ShopsPersistence} from '../modules/shops/shops.persistence.js';import {PasswordService} from '../modules/shops/password.service.js';
import {createShopSchema,shopSettingsSchema,updateProfileSchema,passwordSchema,deliverySchema} from '../modules/shops/contracts.js';
const service=new ShopsService(new ShopsPersistence(),new PasswordService());
const session=(r:FastifyRequest)=>({user:currentUser(r),requestId:r.id,traceId:r.traceId??r.id,ipAddress:r.ip,log:r.log});
const actor=(r:FastifyRequest)=>({...session(r),shop:currentShop(r),role:currentRole(r)});
export const shopRoutes:FastifyPluginAsync=async app=>{
 const auth={preHandler:[app.authenticate]},tenant={preHandler:[app.authenticate,app.resolveShop]},write={preHandler:[app.authenticate,app.resolveShop,app.requireRole(['owner','admin'])]};
 app.get('/session',auth,async r=>service.session(session(r)));
 app.post('/shops',auth,async(r,reply)=>reply.code(201).send(await service.create(session(r),createShopSchema.parse(r.body))));
 app.get('/shop',tenant,async r=>service.find(actor(r)));
 app.patch('/shop',write,async r=>service.update(actor(r),shopSettingsSchema.parse(r.body)));
 app.get('/profile',auth,async r=>service.profile(session(r)));
 app.patch('/profile',auth,async r=>service.updateProfile(session(r),updateProfileSchema.parse(r.body)));
 app.post('/profile/password',auth,async r=>service.password(session(r),passwordSchema.parse(r.body)));
 app.get('/shop/delivery-preview',tenant,async r=>service.delivery(actor(r),deliverySchema.parse(r.query).distanceKm));
};
