-- Database rules that drizzle-kit does not express (docs/domain.md, sections 0, 6, 11, 13.5, 16, 18):
-- append-only tables, immutability of published reference data, deferred circular keys,
-- consent and embedding validation, monthly partitions of the journal.

-- Retention role: the only role allowed to delete from append-only tables (retention and account purge jobs
-- switch to it with SET LOCAL ROLE). It never logs in. The role is cluster-wide, so an existing one is reused.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fsp_retention') THEN
		CREATE ROLE fsp_retention NOLOGIN;
	END IF;
EXCEPTION
	-- Another database of the same cluster created the role concurrently.
	WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
		EXECUTE format('GRANT fsp_retention TO %I', current_user);
	END IF;
END
$$;
--> statement-breakpoint

-- Append-only tables. TG_ARGV[0]: 'purgeable' — the retention role may delete rows (never update);
-- 'immutable' — versioned reference data that nobody deletes or updates.
CREATE FUNCTION forbid_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_ARGV[0] = 'purgeable' AND TG_OP IN ('DELETE', 'TRUNCATE') AND current_user = 'fsp_retention' THEN
		RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NULL END;
	END IF;
	RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
DO $$
DECLARE
	target record;
BEGIN
	FOR target IN
		SELECT * FROM (VALUES
			('consent_events', 'purgeable'),
			('disclosures', 'purgeable'),
			('document_acceptances', 'purgeable'),
			('audit_events', 'purgeable'),
			('assessment_scores', 'purgeable'),
			('inbound_events', 'purgeable'),
			('invitation_terms', 'purgeable'),
			('hiring_reports', 'purgeable'),
			('product_policies', 'immutable'),
			('categorization_rulesets', 'immutable'),
			('match_rulesets', 'immutable')
		) AS t(table_name, mode)
	LOOP
		EXECUTE format(
			'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation(%L)',
			target.table_name || '_append_only', target.table_name, target.mode
		);
		-- Partitioned tables take row triggers only; TRUNCATE of the journal is DROP of old partitions instead.
		IF target.table_name <> 'audit_events' THEN
			EXECUTE format(
				'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation(%L)',
				target.table_name || '_append_only_truncate', target.table_name, target.mode
			);
		END IF;
		IF target.mode = 'purgeable' THEN
			EXECUTE format('GRANT SELECT, DELETE ON %I TO fsp_retention', target.table_name);
		END IF;
	END LOOP;
END
$$;
--> statement-breakpoint

-- Assessment artifacts are append-only, except that after `retention_until` the retention role clears
-- the content and the file reference; the row, its hash and the score stay (domain 10.4).
CREATE FUNCTION assessment_artifacts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF current_user = 'fsp_retention' THEN
		IF TG_OP = 'DELETE' THEN
			RETURN OLD;
		END IF;
		IF NEW.content IS NULL AND NEW.file_id IS NULL
			AND (to_jsonb(NEW) - 'content' - 'file_id') = (to_jsonb(OLD) - 'content' - 'file_id') THEN
			RETURN NEW;
		END IF;
	END IF;
	RAISE EXCEPTION 'table assessment_artifacts is append-only: % is not allowed', TG_OP
		USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER assessment_artifacts_append_only BEFORE UPDATE OR DELETE ON assessment_artifacts
	FOR EACH ROW EXECUTE FUNCTION assessment_artifacts_guard();
--> statement-breakpoint
GRANT SELECT, DELETE, UPDATE (content, file_id) ON assessment_artifacts TO fsp_retention;
--> statement-breakpoint

-- A published legal document is immutable; only `superseded_at` is set later (domain 6.2).
CREATE FUNCTION legal_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.published_at IS NULL THEN
		RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
	END IF;
	IF TG_OP = 'UPDATE'
		AND (to_jsonb(NEW) - 'superseded_at' - 'updated_at') = (to_jsonb(OLD) - 'superseded_at' - 'updated_at')
		AND OLD.superseded_at IS NULL THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'legal document % is published and cannot be changed', OLD.id
		USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER legal_documents_immutable BEFORE UPDATE OR DELETE ON legal_documents
	FOR EACH ROW EXECUTE FUNCTION legal_documents_guard();
--> statement-breakpoint

-- Taxonomy: rows of a version other than `draft` are immutable; a published version may only be retired (domain 11).
CREATE FUNCTION taxonomy_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status = 'draft' THEN
		RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
	END IF;
	IF TG_OP = 'UPDATE' AND OLD.status = 'published' AND NEW.status = 'retired'
		AND (to_jsonb(NEW) - 'status' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'updated_at') THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'taxonomy version % is % and cannot be changed', OLD.id, OLD.status
		USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER taxonomy_versions_immutable BEFORE UPDATE OR DELETE ON taxonomy_versions
	FOR EACH ROW EXECUTE FUNCTION taxonomy_versions_guard();
--> statement-breakpoint
CREATE FUNCTION taxonomy_rows_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	version_id uuid;
BEGIN
	FOREACH version_id IN ARRAY CASE TG_OP
		WHEN 'INSERT' THEN ARRAY[NEW.taxonomy_version_id]
		WHEN 'DELETE' THEN ARRAY[OLD.taxonomy_version_id]
		ELSE ARRAY[OLD.taxonomy_version_id, NEW.taxonomy_version_id] END
	LOOP
		IF (SELECT status FROM taxonomy_versions WHERE id = version_id) <> 'draft' THEN
			RAISE EXCEPTION 'taxonomy version % is not a draft: % on % is not allowed', version_id, TG_OP, TG_TABLE_NAME
				USING ERRCODE = 'restrict_violation';
		END IF;
	END LOOP;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
	table_name text;
BEGIN
	FOREACH table_name IN ARRAY ARRAY[
		'roles', 'skills', 'skill_aliases', 'grades', 'work_formats', 'fsp_projection_rules',
		'fsp_strength_params', 'fsp_level_rules', 'receipt_templates', 'salary_references'
	]
	LOOP
		EXECUTE format(
			'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION taxonomy_rows_guard()',
			table_name || '_taxonomy_draft_only', table_name
		);
	END LOOP;
END
$$;
--> statement-breakpoint

-- An embedding space is immutable; only its status moves building → active → retired (domain 16.2).
CREATE FUNCTION embedding_spaces_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE'
		AND (to_jsonb(NEW) - 'status' - 'activated_at') = (to_jsonb(OLD) - 'status' - 'activated_at')
		AND (OLD.status, NEW.status) IN (('building', 'building'), ('building', 'active'), ('active', 'active'),
			('active', 'retired'), ('building', 'retired'), ('retired', 'retired'))
		AND (OLD.activated_at IS NULL OR NEW.activated_at = OLD.activated_at) THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'embedding space % is immutable: % is not allowed', OLD.id, TG_OP
		USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER embedding_spaces_immutable BEFORE UPDATE OR DELETE ON embedding_spaces
	FOR EACH ROW EXECUTE FUNCTION embedding_spaces_guard();
--> statement-breakpoint

-- Vectors of different spaces never mix: the dimension must be the dimension of the space (domain 16.3).
CREATE FUNCTION embeddings_check_space() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	space record;
BEGIN
	SELECT dimension, status INTO space FROM embedding_spaces WHERE id = NEW.space_id;
	IF space.status = 'retired' THEN
		RAISE EXCEPTION 'embedding space % is retired', NEW.space_id USING ERRCODE = 'check_violation';
	END IF;
	IF vector_dims(NEW.vector) <> space.dimension THEN
		RAISE EXCEPTION 'vector of % dimensions does not belong to space % of % dimensions',
			vector_dims(NEW.vector), NEW.space_id, space.dimension
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER embeddings_space_dimension BEFORE INSERT OR UPDATE ON embeddings
	FOR EACH ROW EXECUTE FUNCTION embeddings_check_space();
--> statement-breakpoint

-- Consent events refer to a published document of the same kind; a grant needs an available document,
-- and a document in written form (article 16 of 152-FZ) needs a signature reference (domain 6.2, 6.3).
CREATE FUNCTION consent_events_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	doc record;
BEGIN
	SELECT kind, form, available, published_at INTO doc FROM legal_documents WHERE id = NEW.document_id;
	IF doc.kind <> NEW.kind THEN
		RAISE EXCEPTION 'consent kind % does not match document kind %', NEW.kind, doc.kind
			USING ERRCODE = 'check_violation';
	END IF;
	IF doc.published_at IS NULL THEN
		RAISE EXCEPTION 'document % is not published', NEW.document_id USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.action = 'grant' AND NOT doc.available THEN
		RAISE EXCEPTION 'consents of kind % are not offered', NEW.kind USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.action = 'grant' AND doc.form = 'electronic_signature'
		AND NOT (NEW.method = 'esign' AND NEW.evidence ? 'signature_ref') THEN
		RAISE EXCEPTION 'consent of kind % requires an electronic signature', NEW.kind
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER consent_events_validate BEFORE INSERT ON consent_events
	FOR EACH ROW EXECUTE FUNCTION consent_events_validate();
--> statement-breakpoint

-- Invitations and their terms reference each other: the invitation points to its current and accepted terms.
-- Both are inserted in one transaction, so the references are checked at commit.
ALTER TABLE invitations ALTER CONSTRAINT invitations_current_terms_id_invitation_terms_id_fk
	DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE invitations ALTER CONSTRAINT invitations_accepted_terms_id_invitation_terms_id_fk
	DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- Monthly partitions of the journal (domain 18.1). Creates missing partitions for `month_count` months starting
-- with the month of `first_month` and returns how many were created. Kept ahead by the retention job.
CREATE FUNCTION audit_events_ensure_partitions(first_month date, month_count integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
	month_start date;
	partition_name text;
	created integer := 0;
BEGIN
	FOR i IN 0 .. month_count - 1 LOOP
		month_start := (date_trunc('month', first_month) + make_interval(months => i))::date;
		partition_name := format('audit_events_%s', to_char(month_start, 'YYYY_MM'));
		IF to_regclass(format('public.%I', partition_name)) IS NULL THEN
			EXECUTE format(
				'CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)',
				partition_name,
				month_start::timestamp AT TIME ZONE 'UTC',
				(month_start + interval '1 month')::timestamp AT TIME ZONE 'UTC'
			);
			created := created + 1;
		END IF;
	END LOOP;
	RETURN created;
END
$$;
--> statement-breakpoint
SELECT audit_events_ensure_partitions((date_trunc('month', now()) - interval '1 month')::date, 27);
--> statement-breakpoint

-- The single row of search settings; without an active space the catalog works in explicit FTS mode.
INSERT INTO search_settings (singleton, active_embedding_space_id) VALUES (true, NULL);
