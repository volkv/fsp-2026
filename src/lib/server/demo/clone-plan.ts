// What a demo session clones and removes (docs/domain.md, section 19.3). Every table of the schema has a decision, and
// every foreign key of a table whose rows a session can own has a kind; a new table or key without one stops cloning
// and purging (and their invariant test) instead of being silently left out or copied.
//
// A row belongs to a demo session when it is one of the session's roots (an account, a profile, a company or a letter
// carrying `demo_session_id`) or when one of its `owner` references names a row that belongs to it. Cloning the cast
// copies the rows that belong to the cast's originals and to nobody's session; purging a session removes the rows that
// belong to it, whoever created them — the clone's own actions included.

/** How a foreign key column of a session-owned table relates the row to the row it names. */
export type EdgeKind =
	/** The row belongs to the named row: cloned with it and removed with it. */
	| 'owner'
	/** The row only names the other one (who acted, a current version): remapped when both are cloned; a row outside the
	 * session naming a removed row is a leak that stops the purge. */
	| 'mention'
	/** As `mention`, but a row outside the session naming a removed row loses the reference (a nullable column). */
	| 'detach'
	/** Reference data or a shared table: never followed. */
	| 'reference';

/** A reference by type and id without a foreign key; the row belongs to the object it names. */
export interface PolymorphicOwner {
	/** SQL expressions over the row (alias `t`) giving the object type and its id as text. */
	type: string;
	id: string;
	/** Object type → the table of its rows; types not listed name no session-owned rows. */
	targets: Readonly<Record<string, string>>;
}

export type TableDecision =
	/** Reference data: published by the start-up scripts, shared by everybody. */
	| { kind: 'reference' }
	/** Rows no session owns: jobs, the journal, integrations, aggregates, the sessions themselves. */
	| { kind: 'shared'; why: string }
	/** Rows a session can own. `copy` — cloned with the cast; `false` — removed with their owners, never cloned. */
	| {
			kind: 'owned';
			copy: boolean;
			/** Accounts, profiles, companies and the letters of a session: `demo_session_id` marks the rows of a session. */
			root?: true;
			edges: Readonly<Record<string, EdgeKind>>;
			polymorphic?: PolymorphicOwner;
			/** Why a table of owned rows is not cloned. */
			why?: string;
	  };

const reference: TableDecision = { kind: 'reference' };

export const DEMO_CLONE_PLAN: Readonly<Record<string, TableDecision>> = {
	// Reference data (the same list as the reset's, domain 19.2).
	taxonomy_versions: reference,
	roles: reference,
	skills: reference,
	skill_aliases: reference,
	grades: reference,
	work_formats: reference,
	fsp_projection_rules: reference,
	fsp_strength_params: reference,
	fsp_level_rules: reference,
	categorization_rulesets: reference,
	match_rulesets: reference,
	receipt_templates: reference,
	salary_references: reference,
	pd_operators: reference,
	legal_documents: reference,
	product_policies: reference,
	vacancy_sources: reference,
	assessments: reference,
	assessment_versions: reference,
	embedding_spaces: reference,
	search_settings: reference,
	eval_runs: reference,

	// Shared rows.
	demo_sessions: { kind: 'shared', why: 'the sessions themselves; a session row goes after its rows' },
	jobs: { kind: 'shared', why: 'the queue: waiting jobs of removed rows are cancelled, the history stays' },
	audit_events: { kind: 'shared', why: 'the journal stays (domain 19.2): identifiers and codes only' },
	erasure_ledger: { kind: 'shared', why: 'the ledger of removed accounts outlives them' },
	inbound_events: { kind: 'shared', why: 'deliveries of the integrations, nobody’s own' },
	market_snapshots: { kind: 'shared', why: 'aggregates of the whole stand' },
	unknown_skill_mentions: { kind: 'shared', why: 'counters of the taxonomy review, no person in them' },
	vacancy_import_runs: { kind: 'shared', why: 'runs of the external sources' },
	legal_representatives: {
		kind: 'shared',
		why: 'the person of a representative; the clone’s representation names the same person'
	},

	// Letters the session sent to people without an account; the originals send none of them.
	demo_letters: {
		kind: 'owned',
		copy: false,
		root: true,
		edges: { demo_session_id: 'reference' },
		why: 'a letter is written by an action within the session'
	},

	// Accounts and access.
	users: { kind: 'owned', copy: true, root: true, edges: { demo_session_id: 'reference' } },
	password_credentials: {
		kind: 'owned',
		copy: false,
		edges: { user_id: 'owner' },
		why: 'a clone is entered through the demo screen, never by password'
	},
	email_tokens: { kind: 'owned', copy: false, edges: { user_id: 'owner' }, why: 'one-time links of the original' },
	external_identities: { kind: 'owned', copy: true, edges: { user_id: 'owner', demo_session_id: 'reference' } },
	athlete_links: {
		kind: 'owned',
		copy: true,
		edges: { user_id: 'owner', basis_identity_id: 'owner', demo_session_id: 'reference' }
	},
	staff_roles: {
		kind: 'owned',
		copy: true,
		edges: { user_id: 'owner', granted_by: 'mention', revoked_by: 'mention' }
	},

	// Companies.
	companies: {
		kind: 'owned',
		copy: true,
		root: true,
		// The original of a clone stays outside the session and is never copied with it.
		edges: { minor_terms_document_id: 'reference', demo_session_id: 'reference', demo_clone_of: 'reference' }
	},
	company_members: {
		kind: 'owned',
		copy: true,
		edges: { company_id: 'owner', user_id: 'owner', invited_by: 'mention', removed_by: 'mention' }
	},
	company_verifications: {
		kind: 'owned',
		copy: true,
		edges: {
			company_id: 'owner',
			applicant_member_id: 'owner',
			authority_evidence_file_id: 'owner',
			decided_by: 'mention'
		}
	},
	api_keys: {
		kind: 'owned',
		copy: false,
		edges: { company_id: 'owner', created_by_member_id: 'owner' },
		why: 'a key is a secret shown once; a clone company makes its own'
	},
	competition_partnerships: { kind: 'owned', copy: true, edges: { company_id: 'owner', granted_by: 'mention' } },

	// Consents, representatives, disclosures.
	document_acceptances: {
		kind: 'owned',
		copy: true,
		edges: { document_id: 'reference', user_id: 'owner', company_id: 'owner' }
	},
	consent_events: {
		kind: 'owned',
		copy: true,
		edges: {
			subject_candidate_id: 'owner',
			document_id: 'reference',
			signer_user_id: 'mention',
			representation_id: 'owner',
			scope_company_id: 'owner',
			scope_invitation_id: 'owner'
		}
	},
	representations: { kind: 'owned', copy: true, edges: { candidate_id: 'owner', representative_id: 'reference' } },
	authority_checks: {
		kind: 'owned',
		copy: true,
		edges: { representation_id: 'owner', evidence_file_id: 'owner', checked_by: 'mention' }
	},
	disclosures: {
		kind: 'owned',
		copy: true,
		edges: {
			candidate_id: 'owner',
			company_id: 'owner',
			recipient_member_id: 'owner',
			invitation_id: 'owner',
			consent_event_id: 'owner'
		}
	},

	// Candidates and their evidence.
	candidates: {
		kind: 'owned',
		copy: true,
		root: true,
		edges: { user_id: 'owner', birth_date_verified_by: 'mention', demo_session_id: 'reference' }
	},
	candidate_company_blocks: { kind: 'owned', copy: true, edges: { candidate_id: 'owner', company_id: 'owner' } },
	external_profiles: { kind: 'owned', copy: true, edges: { candidate_id: 'owner' } },
	source_facts: { kind: 'owned', copy: true, edges: { candidate_id: 'owner', consent_event_id: 'owner' } },
	claims: {
		kind: 'owned',
		copy: true,
		edges: { candidate_id: 'owner', fact_id: 'owner', experience_entry_id: 'owner', ml_result_id: 'owner' }
	},
	skill_inferences: { kind: 'owned', copy: true, edges: { run_id: 'owner', candidate_id: 'owner' } },
	experience_entries: { kind: 'owned', copy: true, edges: { candidate_id: 'owner', fact_id: 'owner' } },
	verification_receipts: { kind: 'owned', copy: true, edges: { fact_id: 'owner', audience_company_id: 'owner' } },
	assessment_attempts: {
		kind: 'owned',
		copy: true,
		edges: { candidate_id: 'owner', version_id: 'reference', annulled_by: 'mention' }
	},
	assessment_scores: {
		kind: 'owned',
		copy: true,
		edges: { attempt_id: 'owner', supersedes_score_id: 'owner', reviewer_id: 'mention' }
	},
	assessment_artifacts: { kind: 'owned', copy: true, edges: { attempt_id: 'owner', file_id: 'owner' } },
	evidence_runs: {
		kind: 'owned',
		copy: true,
		edges: {
			candidate_id: 'owner',
			taxonomy_version_id: 'reference',
			ruleset_id: 'reference',
			job_id: 'reference'
		}
	},
	fsp_level_assignments: { kind: 'owned', copy: true, edges: { run_id: 'owner' } },
	// Categories and objections (domain 23.2); `decision_id` becomes an `owner` edge with its foreign key.
	candidate_categories: { kind: 'owned', copy: true, edges: { candidate_id: 'owner' } },
	assessment_objections: { kind: 'owned', copy: true, edges: { candidate_id: 'owner', assignee_id: 'mention' } },

	// The survey and the declared grade (domain 12.2, 23.2).
	candidate_surveys: {
		kind: 'owned',
		copy: true,
		edges: { candidate_id: 'owner', taxonomy_version_id: 'reference' }
	},
	grade_declarations: { kind: 'owned', copy: true, edges: { candidate_id: 'owner', survey_id: 'owner' } },

	// Vacancies, matches, invitations, hiring.
	vacancies: {
		kind: 'owned',
		copy: true,
		edges: {
			company_id: 'owner',
			created_by_member_id: 'owner',
			// A company of a session records neither on the shared external vacancy (its claim and its own vacancy do).
			claimed_company_id: 'mention',
			derived_from_vacancy_id: 'owner',
			superseded_by_vacancy_id: 'mention',
			taxonomy_version_id: 'reference',
			minor_terms_acceptance_id: 'owner',
			draft_ml_result_id: 'detach'
		}
	},
	vacancy_postings: {
		kind: 'owned',
		copy: false,
		edges: { vacancy_id: 'owner', source: 'reference', last_import_run_id: 'reference' },
		why: 'a listing of an external source is one per source and external id'
	},
	vacancy_claims: {
		kind: 'owned',
		copy: true,
		edges: {
			vacancy_id: 'owner',
			company_id: 'owner',
			requested_by_user_id: 'mention',
			decided_by: 'mention',
			demo_session_id: 'reference'
		}
	},
	match_scores: {
		kind: 'owned',
		copy: true,
		edges: {
			vacancy_id: 'owner',
			candidate_id: 'owner',
			evidence_run_id: 'owner',
			match_ruleset_id: 'reference',
			embedding_space_id: 'reference',
			job_id: 'reference'
		}
	},
	// Needs and offers (domain 13.5, 13.10, 23.2).
	hiring_needs: { kind: 'owned', copy: true, edges: { company_id: 'owner', created_by_member_id: 'owner' } },
	invitations: {
		kind: 'owned',
		copy: true,
		edges: {
			company_id: 'owner',
			candidate_id: 'owner',
			sent_by_member_id: 'owner',
			current_terms_id: 'mention',
			accepted_terms_id: 'mention',
			need_id: 'owner',
			policy_id: 'reference'
		}
	},
	invitation_terms: {
		kind: 'owned',
		copy: true,
		edges: { invitation_id: 'owner', created_by_member_id: 'owner', vacancy_id: 'owner' }
	},
	invitation_responses: {
		kind: 'owned',
		copy: true,
		edges: { invitation_id: 'owner', terms_id: 'owner', consent_event_id: 'owner' }
	},
	hiring_processes: {
		kind: 'owned',
		copy: true,
		edges: { invitation_id: 'owner', company_id: 'owner', candidate_id: 'owner', policy_id: 'reference' }
	},
	hiring_reports: {
		kind: 'owned',
		copy: true,
		edges: { process_id: 'owner', reported_by_user_id: 'mention', supersedes_report_id: 'owner' }
	},

	// Files, parsing, models.
	files: { kind: 'owned', copy: true, edges: { owner_user_id: 'owner' } },
	resume_documents: { kind: 'owned', copy: true, edges: { candidate_id: 'owner', file_id: 'owner' } },
	document_extractions: { kind: 'owned', copy: true, edges: { resume_document_id: 'owner' } },
	ml_results: {
		kind: 'owned',
		copy: true,
		edges: { job_id: 'reference', taxonomy_version_id: 'reference', embedding_space_id: 'reference' },
		polymorphic: {
			type: "t.input_ref ->> 'type'",
			id: "t.input_ref ->> 'id'",
			targets: { document_extraction: 'document_extractions', candidate: 'candidates', vacancy: 'vacancies' }
		}
	},
	embeddings: {
		kind: 'owned',
		copy: true,
		edges: { space_id: 'reference' },
		polymorphic: {
			type: 't.owner_type',
			id: 't.owner_id',
			targets: { candidate_section: 'candidates', vacancy: 'vacancies' }
		}
	},

	// Notifications.
	notification_channels: {
		kind: 'owned',
		copy: false,
		edges: { user_id: 'owner', consent_event_id: 'owner' },
		why: 'a channel is a chat of the original person'
	},
	telegram_link_tokens: {
		kind: 'owned',
		copy: false,
		edges: { user_id: 'owner' },
		why: 'one-time links of the original'
	},
	notification_preferences: { kind: 'owned', copy: true, edges: { user_id: 'owner' } },
	notifications: {
		kind: 'owned',
		copy: true,
		edges: { user_id: 'owner' },
		polymorphic: {
			type: 't.object_type',
			id: 't.object_id::text',
			targets: {
				assessment_objection: 'assessment_objections',
				candidate_category: 'candidate_categories',
				company: 'companies',
				hiring_process: 'hiring_processes',
				invitation: 'invitations',
				representation: 'representations'
			}
		}
	},
	notification_deliveries: {
		kind: 'owned',
		copy: false,
		edges: { notification_id: 'owner', channel_id: 'owner' },
		why: 'deliveries went to the original person'
	}
};

/** A single-column foreign key of the schema. */
export interface ForeignKeyColumn {
	table: string;
	column: string;
	references: string;
	/** Checked at commit: rows referring to each other are inserted in any order within the transaction. */
	deferrable: boolean;
}

export interface ClonePlanMismatch {
	/** Tables of the database without a decision. */
	unplanned: string[];
	/** Planned tables the database lacks. */
	missing: string[];
	/** `table.column` foreign keys of owned tables without a kind. */
	unclassified: string[];
	/** `table.column` kinds the database has no foreign key for. */
	stale: string[];
	/** Owner references and polymorphic targets that lead outside the owned tables. */
	misdirected: string[];
}

export type OwnedDecision = Extract<TableDecision, { kind: 'owned' }>;

export function ownedDecision(table: string): OwnedDecision | null {
	const decision = DEMO_CLONE_PLAN[table];
	return decision?.kind === 'owned' ? decision : null;
}

/** Compares the plan with the tables and foreign keys of the database. */
export function compareWithClonePlan(tables: readonly string[], keys: readonly ForeignKeyColumn[]): ClonePlanMismatch {
	const present = new Set(tables);
	const mismatch: ClonePlanMismatch = {
		unplanned: tables.filter((table) => !Object.hasOwn(DEMO_CLONE_PLAN, table)),
		missing: Object.keys(DEMO_CLONE_PLAN).filter((table) => !present.has(table)),
		unclassified: [],
		stale: [],
		misdirected: []
	};
	const byTable = Map.groupBy(keys, (key) => key.table);
	for (const [table, decision] of Object.entries(DEMO_CLONE_PLAN)) {
		if (decision.kind !== 'owned') continue;
		const columns = new Map((byTable.get(table) ?? []).map((key) => [key.column, key]));
		for (const column of columns.keys()) {
			if (!Object.hasOwn(decision.edges, column)) mismatch.unclassified.push(`${table}.${column}`);
		}
		for (const [column, kind] of Object.entries(decision.edges)) {
			const key = columns.get(column);
			if (!key) {
				mismatch.stale.push(`${table}.${column}`);
				continue;
			}
			if (kind === 'owner' && !ownedDecision(key.references)) mismatch.misdirected.push(`${table}.${column}`);
		}
		for (const target of Object.values(decision.polymorphic?.targets ?? {})) {
			if (!ownedDecision(target)) mismatch.misdirected.push(`${table} → ${target}`);
		}
	}
	return mismatch;
}

/** The problems of a comparison as `kind: items` lines; empty when the plan matches the schema. */
export function planProblems(mismatch: ClonePlanMismatch): string[] {
	const lists: [string, string[]][] = [
		['unplanned', mismatch.unplanned],
		['missing', mismatch.missing],
		['unclassified', mismatch.unclassified],
		['stale', mismatch.stale],
		['misdirected', mismatch.misdirected]
	];
	return lists.filter(([, list]) => list.length > 0).map(([what, list]) => `${what}: ${list.join(', ')}`);
}

export function isPlanComplete(mismatch: ClonePlanMismatch): boolean {
	return planProblems(mismatch).length === 0;
}
