// Typed client for CONTRACTS.md section 5.
//
// The API-shape types below are local stand-ins. Switch them to imports from
// `@planfully/shared` once schema.ts / records.ts land.
//
// The trip secret (URL fragment) is never sent here; only the access token
// derived from it goes in the Authorization header.

export type Location = {
  name?: string;
  address?: string;
  lat?: number;
  lng?: number;
  placeId?: string;
};
export type RosterMember = { id: string; name: string; aliases: string[] };
export type TripMeta = {
  id: string;
  name: string;
  address: string;
  domain: string;
  publicKey: string;
  roster: RosterMember[];
  allowedSenders: string[];
  createdAt: string;
};
export type StoredRecord = {
  seq: number;
  dedupe: string | null;
  ciphertext: string;
  createdAt: string;
};

export type TripAuth = { tripId: string; accessToken: string };

export type CreateTripRequest = {
  name: string;
  publicKey: string;
  accessTokenHash: string;
  roster: RosterMember[];
  allowedSenders: string[];
};

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(
  path: string,
  token: string | undefined,
  init: { method?: string; json?: unknown; body?: BodyInit; contentType?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;
  let body: BodyInit | undefined = init.body;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.contentType) {
    headers['Content-Type'] = init.contentType;
  }
  const res = await fetch(path, { method: init.method ?? 'GET', headers, body });
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const data: unknown = await res.json();
      if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
        message = data.error;
      }
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, message);
  }
  return res;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const trip = (id: string) => `/api/trips/${encodeURIComponent(id)}`;

export async function health(): Promise<{ ok: true }> {
  return json(await request('/api/health', undefined));
}

export async function createTrip(
  adminSecret: string,
  body: CreateTripRequest,
): Promise<{ id: string; address: string; domain: string }> {
  return json(await request('/api/trips', adminSecret, { method: 'POST', json: body }));
}

export async function getTrip(a: TripAuth): Promise<TripMeta> {
  return json(await request(trip(a.tripId), a.accessToken));
}

export async function patchTrip(
  a: TripAuth,
  patch: { name?: string; roster?: RosterMember[]; allowedSenders?: string[] },
): Promise<TripMeta> {
  return json(await request(trip(a.tripId), a.accessToken, { method: 'PATCH', json: patch }));
}

export async function getRecords(
  a: TripAuth,
  since = 0,
): Promise<{ records: StoredRecord[]; latestSeq: number }> {
  return json(await request(`${trip(a.tripId)}/records?since=${since}`, a.accessToken));
}

export async function postRecord(
  a: TripAuth,
  body: { ciphertext: string; dedupe?: string },
): Promise<{ seq: number }> {
  return json(
    await request(`${trip(a.tripId)}/records`, a.accessToken, { method: 'POST', json: body }),
  );
}

export async function deleteRecord(a: TripAuth, seq: number): Promise<void> {
  await request(`${trip(a.tripId)}/records/${seq}`, a.accessToken, { method: 'DELETE' });
}

export async function putBlob(a: TripAuth, blobId: string, bytes: Uint8Array): Promise<void> {
  await request(`${trip(a.tripId)}/blobs/${encodeURIComponent(blobId)}`, a.accessToken, {
    method: 'PUT',
    body: bytes as BodyInit,
    contentType: 'application/octet-stream',
  });
}

export async function getBlob(a: TripAuth, blobId: string): Promise<Uint8Array> {
  const res = await request(`${trip(a.tripId)}/blobs/${encodeURIComponent(blobId)}`, a.accessToken);
  return new Uint8Array(await res.arrayBuffer());
}

export async function geocode(a: TripAuth, q: string): Promise<{ results: Location[] }> {
  return json(await request(`${trip(a.tripId)}/geocode?q=${encodeURIComponent(q)}`, a.accessToken));
}
