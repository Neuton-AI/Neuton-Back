-- Verification must recheck soft deletion after its earlier unlocked read.
GRANT SELECT(deleted_at) ON public.orders TO neuton_bootstrap;
CREATE OR REPLACE FUNCTION app_private.mark_order_delivered(target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer;
BEGIN
 IF app_private.lock_shop_context() IS NULL THEN
  RAISE EXCEPTION 'Order verification forbidden' USING ERRCODE='42501';
 END IF;
 UPDATE public.orders SET status='delivered'
 WHERE id=target AND shop_id=app_private.context_uuid('neuton.shop_id')
 AND status='processing' AND deleted_at IS NULL;
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed=1;
END $$;
