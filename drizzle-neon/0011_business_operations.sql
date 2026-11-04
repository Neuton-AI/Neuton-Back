-- A recipe referenced by historical orders is deactivated rather than removed.
-- Its upload metadata must still be removed atomically with cleanup enqueueing.
GRANT DELETE ON public.media_uploads TO neuton_app;
CREATE POLICY uploads_inactive_recipe_delete ON public.media_uploads FOR DELETE TO neuton_app
USING (
  app_private.shop_access(shop_id,true)
  AND recipe_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.recipes recipe
    WHERE recipe.id=media_uploads.recipe_id AND recipe.shop_id=media_uploads.shop_id AND NOT recipe.is_active
  )
);
