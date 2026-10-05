-- Edited by hand: the evaluations made before the scope existed compared the shortlist with a keyword search over the
-- whole visible catalog — they get `whole_catalog`; new rows name their scope, so the default is dropped at once.
ALTER TABLE "shortlist_evaluations" ADD COLUMN "scope" text DEFAULT 'whole_catalog' NOT NULL;--> statement-breakpoint
ALTER TABLE "shortlist_evaluations" ALTER COLUMN "scope" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shortlist_evaluations" ADD CONSTRAINT "shortlist_evaluations_scope_values" CHECK ("shortlist_evaluations"."scope" in ('confirmed_pool', 'whole_catalog'));
