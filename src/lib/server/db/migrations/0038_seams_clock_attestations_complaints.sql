ALTER TABLE "invitation_complaints" DROP CONSTRAINT "invitation_complaints_decision_fields";--> statement-breakpoint
DROP INDEX "challenge_deliveries_candidate";--> statement-breakpoint
DROP INDEX "category_attestations_category";--> statement-breakpoint
ALTER TABLE "invitation_complaints" ALTER COLUMN "terms_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation_complaints" ALTER COLUMN "text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "challenge_deliveries" ADD COLUMN "clock_at" timestamp with time zone;--> statement-breakpoint
UPDATE "challenge_deliveries" SET "clock_at" = "delivered_at";--> statement-breakpoint
ALTER TABLE "challenge_deliveries" ALTER COLUMN "clock_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation_complaints" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "category_attestations" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "challenge_deliveries_candidate" ON "challenge_deliveries" USING btree ("candidate_id","clock_at");--> statement-breakpoint
CREATE UNIQUE INDEX "category_attestations_category" ON "category_attestations" USING btree ("category_id") WHERE "category_attestations"."superseded_at" is null;--> statement-breakpoint
ALTER TABLE "invitation_complaints" ADD CONSTRAINT "invitation_complaints_tombstone" CHECK (case when "invitation_complaints"."purged_at" is null then "invitation_complaints"."text" is not null and "invitation_complaints"."terms_id" is not null
				else "invitation_complaints"."status" = 'decided' and "invitation_complaints"."text" is null and "invitation_complaints"."terms_id" is null and "invitation_complaints"."resolution" is null end);--> statement-breakpoint
ALTER TABLE "invitation_complaints" ADD CONSTRAINT "invitation_complaints_decision_fields" CHECK (case "invitation_complaints"."status"
				when 'open' then "invitation_complaints"."decision" is null and "invitation_complaints"."resolution" is null and "invitation_complaints"."decided_by" is null and "invitation_complaints"."decided_at" is null
				else "invitation_complaints"."decision" is not null and ("invitation_complaints"."resolution" is not null or "invitation_complaints"."purged_at" is not null)
					and "invitation_complaints"."decided_at" is not null end);--> statement-breakpoint
ALTER TABLE "category_attestations" ADD CONSTRAINT "category_attestations_superseded" CHECK ("category_attestations"."superseded_at" is null or "category_attestations"."superseded_at" >= "category_attestations"."issued_at");