// Barrel of all Drizzle tables: drizzle-kit reads this folder, and `db()` passes the exports as its schema.
// One module per aggregate of docs/domain.md, section 2.
export * from './assessments';
export * from './audit';
export * from './candidates';
export * from './categories';
export * from './companies';
export * from './consent';
export * from './demo';
export * from './documents';
export * from './evidence';
export * from './evidence-runs';
export * from './hiring';
export * from './identity';
export * from './integrations';
export * from './jobs';
export * from './market';
export * from './matching';
export * from './ml';
export * from './notifications';
export * from './policies';
export * from './taxonomy';
export * from './vacancies';
