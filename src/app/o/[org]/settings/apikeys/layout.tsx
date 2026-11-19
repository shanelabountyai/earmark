import { pageGuard } from '@/earmark/page-guard';

// Earmark D-57: the 404, not the error page, for a role without `apikeys.manage` (the page below still checks it).
export default pageGuard('apikeys.manage');
