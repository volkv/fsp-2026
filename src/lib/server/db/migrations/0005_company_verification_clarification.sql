-- A verification request may be sent back for clarification (docs/domain.md, section 5.2): decision `needs_info` with
-- the operator's reason, the company returns to `draft`. One open request per company.
ALTER TABLE "company_verifications" DROP CONSTRAINT "company_verifications_decision_values";--> statement-breakpoint
ALTER TABLE "company_verifications" DROP CONSTRAINT "company_verifications_rejection_reason";--> statement-breakpoint
CREATE UNIQUE INDEX "company_verifications_open" ON "company_verifications" USING btree ("company_id") WHERE "company_verifications"."decision" is null;--> statement-breakpoint
ALTER TABLE "company_verifications" ADD CONSTRAINT "company_verifications_decision_values" CHECK ("company_verifications"."decision" in ('approved', 'rejected', 'needs_info'));--> statement-breakpoint
ALTER TABLE "company_verifications" ADD CONSTRAINT "company_verifications_rejection_reason" CHECK ("company_verifications"."decision" not in ('rejected', 'needs_info') or "company_verifications"."reason" is not null);