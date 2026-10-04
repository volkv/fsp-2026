-- Text checks stored before moderation cases were kept carry no `moderation` key; the case is `null` for them: none was
-- opened. Rows that already have the key are left as they are, so the statement may run again.
UPDATE "vacancies" SET "text_check" = "text_check" || '{"moderation": null}'::jsonb WHERE NOT "text_check" ? 'moderation';
