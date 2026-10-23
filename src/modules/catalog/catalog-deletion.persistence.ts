import { and, eq } from "drizzle-orm";
import { recipes, mediaUploads } from "../../db/schema/index.js";
import { notFound } from "../../lib/errors.js";
import { scheduleObjectDeletions } from "../../lib/storageCleanup.js";
import type { CatalogDatabase } from "./catalog.persistence.js";

function isForeignKeyViolation(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; candidate && depth < 4; depth++) {
    if (typeof candidate !== "object") return false;
    if ("code" in candidate && candidate.code === "23503") return true;
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }
  return false;
}

export class CatalogDeletionPersistence {
  constructor(private readonly database: CatalogDatabase) {}
  delete(
    shopId: string,
    id: string,
    traceId: string,
  ): Promise<{ ok: true; mode: "hard" | "soft" }> {
    return this.database.transaction(async (tx) => {
      const [recipe] = await tx
        .select({ id: recipes.id, storagePath: recipes.storagePath })
        .from(recipes)
        .where(and(eq(recipes.id, id), eq(recipes.shopId, shopId)))
        .limit(1)
        .for("update");
      if (!recipe) throw notFound("Recipe not found");
      const uploads = await tx
        .select({ sources: mediaUploads.sources })
        .from(mediaUploads)
        .where(
          and(eq(mediaUploads.recipeId, id), eq(mediaUploads.shopId, shopId)),
        );
      let mode: "hard" | "soft" = "hard";
      try {
        // Recover from the expected FK refusal without aborting the owning transaction.
        await tx.transaction(async (savepoint) => {
          await savepoint
            .delete(recipes)
            .where(and(eq(recipes.id, id), eq(recipes.shopId, shopId)));
        });
      } catch (error) {
        if (!isForeignKeyViolation(error)) throw error;
        mode = "soft";
        await tx
          .update(recipes)
          .set({
            isActive: false,
            storagePath: null,
            imageUrl: null,
            updatedAt: new Date(),
          })
          .where(and(eq(recipes.id, id), eq(recipes.shopId, shopId)));
        await tx
          .delete(mediaUploads)
          .where(
            and(eq(mediaUploads.recipeId, id), eq(mediaUploads.shopId, shopId)),
          );
      }
      await scheduleObjectDeletions(tx, {
        shopId,
        traceId,
        paths: [
          recipe.storagePath,
          ...uploads.flatMap((upload) =>
            upload.sources.map((source) => source.storagePath),
          ),
        ],
      });
      return { ok: true, mode };
    });
  }
}
