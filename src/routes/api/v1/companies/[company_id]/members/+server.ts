import { serve } from '$lib/server/api/serve';
import { inviteCompanyMember, listCompanyMembers } from '$lib/server/api/v1/companies';

export const GET = serve(listCompanyMembers);
export const POST = serve(inviteCompanyMember);
