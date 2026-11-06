// Control (FR-07): an inline server action, which discover() cannot see.
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

export default function Form() {
  async function wipe() {
    'use server';
    await db.project.deleteMany();
  }
  return <form action={wipe}><button>Wipe</button></form>;
}
