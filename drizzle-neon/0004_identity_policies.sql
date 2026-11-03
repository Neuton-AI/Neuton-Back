GRANT SELECT ON public.profiles, public.shops, public.shop_members, public.audit_logs TO neuton_app;
GRANT UPDATE(full_name,avatar_url,updated_at) ON public.profiles TO neuton_app;
GRANT UPDATE(name,slug,currency,timezone,store_address,target_profit_margin,hourly_labor_cost,
 delivery_base_fee,delivery_rate_per_km,updated_at) ON public.shops TO neuton_app;
GRANT INSERT ON public.audit_logs TO neuton_app;

CREATE POLICY profiles_read ON public.profiles FOR SELECT TO neuton_app
 USING(app_private.session_valid() AND id=app_private.context_uuid('neuton.user_id'));
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO neuton_app
 USING(app_private.session_valid() AND id=app_private.context_uuid('neuton.user_id'))
 WITH CHECK(app_private.session_valid() AND id=app_private.context_uuid('neuton.user_id'));
CREATE POLICY memberships_read ON public.shop_members FOR SELECT TO neuton_app
 USING(app_private.session_valid() AND user_id=app_private.context_uuid('neuton.user_id'));
CREATE POLICY shops_read ON public.shops FOR SELECT TO neuton_app
 USING(app_private.member_role(id) IS NOT NULL);
CREATE POLICY shops_update ON public.shops FOR UPDATE TO neuton_app
 USING(app_private.shop_access(id,true)) WITH CHECK(app_private.shop_access(id,true));
CREATE POLICY audit_read ON public.audit_logs FOR SELECT TO neuton_app
 USING(app_private.shop_access(shop_id,true));
CREATE POLICY audit_append ON public.audit_logs FOR INSERT TO neuton_app
 WITH CHECK(app_private.shop_access(shop_id) AND user_id=app_private.context_uuid('neuton.user_id'));
