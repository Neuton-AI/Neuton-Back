-- N-28: receipt status switchover.
--
-- `completed` has always meant "extracted AND applied", which is exactly what
-- `verified` means from here on, so history carries straight over: the three
-- receipts that used to count as expenses keep counting as expenses, and the
-- expense/revenue history the dashboard draws does not move by a single unit.
--
-- This runs first and alone for a reason. `receipts.status` is plain text with
-- no CHECK constraint (every `WITH CHECK` in the schema belongs to an RLS
-- policy), so this UPDATE is the only thing that can ever remove a stray
-- `completed` — a value no query would match and nothing would complain about.
-- Pre-flight counts are recorded in the PR that ships it.
UPDATE "receipts" SET "status" = 'verified' WHERE "status" = 'completed';
--> statement-breakpoint
-- `applying` retired together with the worker's inventory writes. No live row
-- carries it today, but a job that died mid-write between N-27 and this deploy
-- could, and nothing else rewrites it. `validating` is the stage it became: the
-- worker is still reading lines in, it just no longer applies them.
UPDATE "receipts" SET "progress_stage" = 'validating' WHERE "progress_stage" = 'applying';
