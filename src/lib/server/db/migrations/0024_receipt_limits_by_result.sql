-- What a receipt does not assert depends on the kind of a competition result and the role in the team (domain 9.6):
-- `{ all, team, individual, byRole }`. The templates of the versions already published keep their texts as `all`:
-- they are the texts their receipts were issued with. Changing the type rewrites the table without row triggers, so
-- the immutability of published versions (migration 0002) is not touched otherwise.
ALTER TABLE "receipt_templates" ALTER COLUMN "does_not_assert" SET DATA TYPE jsonb
	USING jsonb_build_object(
		'all', to_jsonb("does_not_assert"),
		'team', '[]'::jsonb,
		'individual', '[]'::jsonb,
		'byRole', '{}'::jsonb
	);
