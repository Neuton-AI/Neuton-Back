-- Members create their own processing orders; updates and cancellation retain
-- the existing administrative policies and narrow delivery-verification routine.
CREATE POLICY member_order_insert ON public.orders FOR INSERT TO neuton_app
WITH CHECK (
  app_private.shop_access(shop_id)
  AND app_private.member_role(shop_id)='member'
  AND user_id=app_private.context_uuid('neuton.user_id')
  AND status='processing' AND deleted_at IS NULL
);

CREATE POLICY member_order_item_insert ON public.order_items FOR INSERT TO neuton_app
WITH CHECK (
  app_private.shop_access(shop_id)
  AND app_private.member_role(shop_id)='member'
  AND EXISTS (
    SELECT 1 FROM public.orders parent
    WHERE parent.id=order_items.order_id AND parent.shop_id=order_items.shop_id
      AND parent.user_id=app_private.context_uuid('neuton.user_id')
      AND parent.status='processing' AND parent.deleted_at IS NULL
  )
);

CREATE OR REPLACE FUNCTION app_private.next_order_number() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result integer;
BEGIN
 IF app_private.lock_shop_context() IS NULL THEN
  RAISE EXCEPTION 'Order creation forbidden' USING ERRCODE='42501';
 END IF;
 UPDATE public.shops SET last_order_number=last_order_number+1
 WHERE id=app_private.context_uuid('neuton.shop_id') RETURNING last_order_number INTO result;
 RETURN result;
END $$;
