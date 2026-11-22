// PRD-B B2 (Shane's decision 4 (b), D-75): the six accounts the README's *Try the live demo* walks, in its order, with
// who each one is and the steps it is used in. The words follow the README's table and scripts/seed-earmark.ts; every
// other seeded account is listed under a fold on /demo. Synthetic people only.
export type WalkAccount = { email: string; who: string; steps: string; start?: true };

export const WALK_ACCOUNTS: readonly WalkAccount[] = [
  { email: 'owner@northwind.demo.test', who: 'Owner of Northwind, the client company', steps: 'Steps 1, 2 and 8: the dashboard, a replanned line, the audit log', start: true },
  { email: 'member@northwind.demo.test', who: 'Campaign manager; also holds the Demand Gen Owner seat', steps: 'Step 3: a request and its frozen approval chain' },
  { email: 'demandgen@northwind.demo.test', who: 'The other Demand Gen Owner', steps: 'Step 4: the first approval' },
  { email: 'admin@northwind.demo.test', who: 'Marketing operations; holds the Marketing Ops seat', steps: 'Steps 4 and 7: the second approval, matching an invoice' },
  { email: 'finance@northwind.demo.test', who: 'Holds the Finance seat', steps: 'Step 7: approving an invoice for payment' },
  { email: 'dana@meridian.demo.test', who: 'Agency staff at Meridian Creative, a guest in two clients', steps: 'Steps 5 and 6: the agency view and the tenant wall' },
];
