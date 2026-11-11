import { createHmac } from 'node:crypto';
import { env } from '@/core/env';

// The demo webhook receiver (PRD §9 step 6), standing in for a client's AP system. It holds its own secret, as a real
// receiver would, derived from AUTH_SECRET so seed:demo can give the same one to Northwind's endpoint without storing it.
export const DEMO_RECEIVER_PATH = '/api/demo/webhook';
export const demoReceiverUrl = () => new URL(DEMO_RECEIVER_PATH, env.APP_URL).toString();
export const demoReceiverSecret = () => `whsec_${createHmac('sha256', env.AUTH_SECRET).update('earmark demo webhook receiver').digest('base64url')}`;
