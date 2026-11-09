import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { API_SCOPES } from '@/app/api-scopes';
import { EVENT_TYPES } from '@/app/event-types';
import { listKeys } from '@/modules/apikeys/keys';
import { listDeliveries, listEndpoints } from '@/modules/apikeys/webhooks';
import { createApiKey, createWebhookEndpoint, deleteWebhookEndpoint, replayWebhookDelivery, revokeApiKey, rotateWebhookSecret, setWebhookStatus } from './actions';

export const metadata = { title: 'API keys and webhooks' };

const when = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never');

export default async function ApiKeys({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org, 'apikeys.manage');
  const [keys, endpoints, deliveries] = await Promise.all([listKeys(ctx), listEndpoints(ctx), listDeliveries(ctx)]);
  const slug = ctx.slug;
  const hidden = (id: string) => <input type="hidden" name="id" value={id} />;

  return (
    <main>
      <h1>API keys and webhooks</h1>
      <p>
        An integration calls <code>/api/v1</code> with <code>Authorization: Bearer &lt;key&gt;</code>. A key reaches this org only, with the scopes you
        give it, and stops working on its next request once revoked.
      </p>

      <h2>Keys</h2>
      <ul>
        {keys.map((k) => (
          <li key={k.id}>
            <strong>{k.label}</strong> <code>{k.prefix}…</code> · {k.scopes.join(', ')} · last used {when(k.lastUsedAt)}
            {k.revokedAt ? (
              <> · revoked {when(k.revokedAt)}</>
            ) : (
              <ActionForm action={revokeApiKey.bind(null, slug)}>
                {hidden(k.id)}
                <button type="submit">Revoke</button>
              </ActionForm>
            )}
          </li>
        ))}
      </ul>
      <ActionForm action={createApiKey.bind(null, slug)}>
        <label>
          Label <input name="label" required maxLength={80} placeholder="CRM sync" />
        </label>
        <fieldset>
          <legend>Scopes</legend>
          {Object.entries(API_SCOPES).map(([s, { label, perMinute }]) => (
            <label key={s}>
              <input type="checkbox" name="scopes[]" value={s} defaultChecked={s === 'read'} /> {label} ({perMinute} a minute)
            </label>
          ))}
        </fieldset>
        <button type="submit">Create key</button>
      </ActionForm>

      <h2>Webhook endpoints</h2>
      <p>
        Each delivery is signed: the <code>Webhook-Signature</code> header is <code>t=&lt;unix seconds&gt;,v1=&lt;HMAC-SHA256 of &quot;t.body&quot;&gt;</code>.
        Reject a timestamp more than 5 minutes off, and dedupe on <code>Webhook-Event-Id</code>. A receiver that was down catches up with{' '}
        <code>GET /api/v1/events?since=&lt;last seq&gt;</code>.
      </p>
      <ul>
        {endpoints.map((e) => (
          <li key={e.id}>
            <strong>{e.url}</strong> · {e.eventTypes.length ? e.eventTypes.join(', ') : 'every event'} · <strong>{e.status}</strong>
            {e.disabledReason && <> ({e.disabledReason})</>}
            {e.previousSecretExpiresAt && e.previousSecretExpiresAt > new Date() && <> · previous secret signs until {when(e.previousSecretExpiresAt)}</>}
            <ActionForm action={setWebhookStatus.bind(null, slug)}>
              {hidden(e.id)}
              <input type="hidden" name="to" value={e.status === 'active' ? 'disabled' : 'active'} />
              <button type="submit">{e.status === 'active' ? 'Switch off' : 'Resume'}</button>
            </ActionForm>
            <ActionForm action={rotateWebhookSecret.bind(null, slug)}>
              {hidden(e.id)}
              <button type="submit">Rotate secret</button>
            </ActionForm>
            <ActionForm action={deleteWebhookEndpoint.bind(null, slug)}>
              {hidden(e.id)}
              <button type="submit">Delete</button>
            </ActionForm>
          </li>
        ))}
      </ul>
      <ActionForm action={createWebhookEndpoint.bind(null, slug)}>
        <label>
          URL <input name="url" type="url" required placeholder="https://example.com/webhooks" />
        </label>
        <fieldset>
          <legend>Events (none ticked = every event)</legend>
          {EVENT_TYPES.map((t) => (
            <label key={t}>
              <input type="checkbox" name="eventTypes[]" value={t} /> {t}
            </label>
          ))}
        </fieldset>
        <button type="submit">Add endpoint</button>
      </ActionForm>

      <h2>Recent deliveries</h2>
      {deliveries.length === 0 ? (
        <p>None yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Seq</th>
              <th>Event</th>
              <th>Endpoint</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Last answer</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td>{d.seq}</td>
                <td>{d.event.type}</td>
                <td>{d.endpoint.url}</td>
                <td>
                  {d.status}
                  {d.replayed && ' (replayed)'}
                  {d.nextAttemptAt && d.status === 'failed' && <>, retry {when(d.nextAttemptAt)}</>}
                </td>
                <td>{d.attempts}</td>
                <td>{d.lastResponseStatus ?? d.lastError ?? ''}</td>
                <td>
                  {d.status !== 'sending' && d.status !== 'pending' && (
                    <ActionForm action={replayWebhookDelivery.bind(null, slug)}>
                      {hidden(d.id)}
                      <button type="submit">Replay</button>
                    </ActionForm>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
