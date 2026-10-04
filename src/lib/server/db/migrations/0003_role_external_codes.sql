-- External codes of a role become lists (docs/domain.md, section 11): a role maps to several hh.ru professional roles,
-- Habr Career specializations and professional standards. An existing code becomes a one-element list, a missing one
-- an empty list. The type change rewrites the table without firing row triggers, so rows of published taxonomy
-- versions are converted, not refused; their content is the same codes in the new shape.
ALTER TABLE "roles" ALTER COLUMN "hh_role_id" SET DATA TYPE text[]
	USING CASE WHEN "hh_role_id" IS NULL THEN '{}'::text[] ELSE ARRAY["hh_role_id"] END;--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "hh_role_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "habr_spec" SET DATA TYPE text[]
	USING CASE WHEN "habr_spec" IS NULL THEN '{}'::text[] ELSE ARRAY["habr_spec"] END;--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "habr_spec" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "prof_standard" SET DATA TYPE text[]
	USING CASE WHEN "prof_standard" IS NULL THEN '{}'::text[] ELSE ARRAY["prof_standard"] END;--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "prof_standard" SET NOT NULL;
