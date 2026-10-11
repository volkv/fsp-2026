import type { Workspace } from '$lib/navigation.js';
import type { WorkspaceTour } from '../types.js';
import { adminTour } from './admin.js';
import { candidateTour } from './candidate.js';
import { employerTour } from './employer.js';
import { operatorTour } from './operator.js';

export const WORKSPACE_TOURS: Record<Workspace, WorkspaceTour> = {
	candidate: candidateTour,
	employer: employerTour,
	operator: operatorTour,
	admin: adminTour
};
