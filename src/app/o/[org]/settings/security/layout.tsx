import { pageGuard } from '@/earmark/page-guard';

// Earmark D-57: the 404, not the error page, for a role without `audit.read` (the page below still checks it).
export default pageGuard('audit.read');
