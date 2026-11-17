import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  deriveTripKeys,
  encodeSecret,
  fromBase64,
  generateSecret,
  openJson,
  type Event,
  type RecordBody,
} from '@planfully/shared';
import { ApiError } from '../lib/api';
import { createTripActions } from './actions';
import { createTripStore, type TripApi } from './store';

const META = {
  id: 't1',
  name: 'Lisbon',
  address: 'a@b.c',
  domain: 'b.c',
  publicKey: 'x',
  roster: [],
  allowedSenders: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const secret = generateSecret();
const fragment = '#' + encodeSecret(secret);
let keys: Awaited<ReturnType<typeof deriveTripKeys>>;
beforeEach(async () => {
  keys = await deriveTripKeys(secret);
});

async function setup(postRecord: ReturnType<typeof vi.fn>) {
  const api: TripApi = {
    getTrip: vi.fn().mockResolvedValue(META),
    getRecords: vi.fn().mockResolvedValue({ records: [], latestSeq: 0, more: false }),
  };
  const store = createTripStore({ tripId: 't1', fragment, api, intervalMs: 1e9 });
  store.start();
  await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
  const actions = createTripActions(store, { api: { postRecord } as never });
  return { store, actions };
}

async function bodyOf(call: unknown[]): Promise<RecordBody> {
  const req = call[1] as { ciphertext: string; dedupe?: string };
  expect(req.dedupe).toBeUndefined();
  return openJson<RecordBody>(keys.privateKey, fromBase64(req.ciphertext));
}

function emailPut(id: string): RecordBody {
  return {
    kind: 'put',
    event: {
      id,
      type: 'flight',
      name: 'TP123',
      status: 'confirmed',
      attachments: [],
      participants: [],
      source: 'email',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('actions', () => {
  test('putEvent seals a manual put, shows it immediately, then swaps in the real seq', async () => {
    let resolve!: (v: { seq: number }) => void;
    const post = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    const { store, actions } = await setup(post);
    const p = actions.putEvent({ name: 'Dinner', type: 'activity' });
    expect(store.getState().events.map((e) => e.name)).toEqual(['Dinner']);
    expect(store.getState().pending).toBe(1);
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    resolve({ seq: 7 });
    const event = await p;
    const s = store.getState();
    expect(s.pending).toBe(0);
    expect(s.lastError).toBeNull();
    expect(s.records.map((r) => r.seq)).toEqual([7]);
    expect(s.cursor).toBe(0);
    const body = await bodyOf(post.mock.calls[0] as unknown[]);
    expect((post.mock.calls[0] as unknown[])[0]).toEqual({
      tripId: 't1',
      accessToken: keys.accessToken,
    });
    expect(body.kind).toBe('put');
    const e = (body as Extract<RecordBody, { kind: 'put' }>).event;
    expect(e).toMatchObject({
      id: event.id,
      name: 'Dinner',
      source: 'manual',
      attachments: [],
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(e.createdAt)).not.toBeNaN();
  });

  test('patchEvent and deleteEvent send the right bodies', async () => {
    const post = vi.fn().mockResolvedValueOnce({ seq: 1 }).mockResolvedValueOnce({ seq: 2 });
    const { store, actions } = await setup(post);
    store.getState().append([{ seq: 1, dedupe: null, createdAt: 'x', body: emailPut('e1') }]);
    await actions.patchEvent('e1', { name: 'Renamed' });
    await actions.deleteEvent('e1');
    expect(await bodyOf(post.mock.calls[0] as unknown[])).toEqual({
      kind: 'patch',
      target: 'e1',
      fields: { name: 'Renamed' },
    });
    expect(await bodyOf(post.mock.calls[1] as unknown[])).toEqual({ kind: 'delete', target: 'e1' });
    expect(store.getState().events).toEqual([]);
  });

  test('a failed POST rolls back and sets lastError, which a later success does not clear', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, 'boom'))
      .mockResolvedValueOnce({ seq: 3 });
    const { store, actions } = await setup(post);
    store.getState().append([{ seq: 1, dedupe: null, createdAt: 'x', body: emailPut('e1') }]);
    await expect(actions.patchEvent('e1', { name: 'X' })).rejects.toThrow();
    let s = store.getState();
    expect(s.events[0]?.name).toBe('TP123');
    expect(s.records.map((r) => r.seq)).toEqual([1]);
    expect(s.pending).toBe(0);
    expect(s.lastError?.kind).toBe('network');
    await actions.patchEvent('e1', { name: 'Y' });
    s = store.getState();
    expect(s.lastError?.kind).toBe('network');
    s.setWriteState({ lastError: null });
    expect(store.getState().lastError).toBeNull();
    expect(s.events[0]?.name).toBe('Y');
  });

  test('sendRecord can be replaced', async () => {
    const post = vi.fn();
    const { store, actions: _ } = await setup(post);
    const sendRecord = vi.fn().mockResolvedValue({ seq: 9 });
    const actions = createTripActions(store, { sendRecord });
    await actions.deleteEvent('nope');
    expect(sendRecord).toHaveBeenCalledOnce();
    expect((sendRecord.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Uint8Array);
    expect(post).not.toHaveBeenCalled();
  });

  test('a patch to an email event survives a later email put in the same group', async () => {
    const post = vi.fn().mockResolvedValue({ seq: 2 });
    const { store, actions } = await setup(post);
    store.getState().append([{ seq: 1, dedupe: 'tag', createdAt: 'x', body: emailPut('e1') }]);
    await actions.patchEvent('e1', { name: 'My flight' });
    const later = emailPut('e2') as Extract<RecordBody, { kind: 'put' }>;
    later.event = { ...later.event, name: 'TP123 updated', notes: 'gate B' } as Event;
    store.getState().append([{ seq: 3, dedupe: 'tag', createdAt: 'x', body: later }]);
    const ev = store.getState().events;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ id: 'e1', name: 'My flight', notes: 'gate B' });
  });

  test('sends go out in call order, so a patch never gets a lower seq than its put', async () => {
    const order: string[] = [];
    let n = 0;
    const post = vi.fn().mockImplementation(async (_a, req: { ciphertext: string }) => {
      const body = await openJson<RecordBody>(keys.privateKey, fromBase64(req.ciphertext));
      // The put is slower than the patch would be if sends were concurrent.
      if (body.kind === 'put') await new Promise((r) => setTimeout(r, 30));
      order.push(body.kind);
      return { seq: ++n };
    });
    const { store, actions } = await setup(post);
    const ev = actions.putEvent({ name: 'A', type: 'activity' });
    const id = store.getState().events[0]?.id as string;
    const patch = actions.patchEvent(id, { name: 'B' });
    await Promise.all([ev, patch]);
    expect(order).toEqual(['put', 'patch']);
    expect(store.getState().records.map((r) => r.seq)).toEqual([1, 2]);
    expect(store.getState().events[0]?.name).toBe('B');
  });

  test('when a put fails, queued patches and deletes for it are dropped, not sent', async () => {
    const post = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom'));
    const { store, actions } = await setup(post);
    const put = actions.putEvent({ name: 'A', type: 'activity' });
    const id = store.getState().events[0]?.id as string;
    const patch = actions.patchEvent(id, { name: 'B' });
    const del = actions.deleteEvent(id);
    const results = await Promise.allSettled([put, patch, del]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(post).toHaveBeenCalledTimes(1);
    const s = store.getState();
    expect(s.records).toEqual([]);
    expect(s.pending).toBe(0);
  });

  test('explicit undefined fields in putEvent do not override defaults', async () => {
    const post = vi.fn().mockResolvedValue({ seq: 1 });
    const { store, actions } = await setup(post);
    const e = await actions.putEvent({
      name: 'A',
      type: 'activity',
      attachments: undefined,
      participants: undefined,
      status: undefined,
    });
    expect(e).toMatchObject({ attachments: [], participants: [], status: 'confirmed' });
    expect(store.getState().events).toHaveLength(1);
  });
});
