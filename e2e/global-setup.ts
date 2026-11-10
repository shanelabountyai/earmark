import { seedDemo } from '../scripts/seed-demo';

// One seed per sweep. Two spec files seeding in parallel workers raced on the seed's unique keys (Seat_orgId_name_key).
export default async function globalSetup() { await seedDemo(); }
