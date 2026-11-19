import { pageGuard } from '@/earmark/page-guard';

// Earmark D-57: the 404, not the error page, for a role without `org.update` (the page below still checks it).
export default pageGuard('org.update');
