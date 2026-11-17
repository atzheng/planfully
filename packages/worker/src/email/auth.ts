import { addressParser } from 'postal-mime';

/**
 * Sender authentication from the Authentication-Results header that Cloudflare
 * Email Routing prepends before invoking the Worker.
 * https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#authentication-results
 */

/**
 * The single From mailbox, lowercased with any trailing dot dropped from the domain.
 * Fails closed (null) for zero or several mailboxes, group syntax, several From headers
 * (Headers.get joins them with ", ", which parses as several mailboxes) or junk.
 */
export function senderAddress(from: string | null): string | null {
  if (!from) return null;
  let list: ReturnType<typeof addressParser>;
  try {
    list = addressParser(from);
  } catch {
    return null;
  }
  const [one, ...rest] = list;
  if (!one || rest.length > 0 || one.group !== undefined || !one.address) return null;
  const at = one.address.lastIndexOf('@');
  if (at < 1) return null;
  const domain = one.address
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, '');
  if (!domain) return null;
  return `${one.address.slice(0, at).toLowerCase()}@${domain}`;
}

const TRUSTED_AUTHSERV = 'mx.cloudflare.net';

/**
 * Takes the value of `message.headers.get('authentication-results')` (several
 * headers are joined with ", ") and returns only the first header's text, and only
 * if its authserv-id is mx.cloudflare.net. Headers supplied by the sender sit after
 * Cloudflare's, so they are cut off and anything else is rejected.
 */
function trustedResults(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v.startsWith(`${TRUSTED_AUTHSERV};`)) return null;
  const head = TRUSTED_AUTHSERV.length + 1;
  // Start of a further header: ", <authserv-id>;"
  const next = /,\s*[a-z0-9.-]+\s*;/.exec(v.slice(head));
  return next ? v.slice(0, head + next.index) : v;
}

function domainOf(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = v
    .slice(v.lastIndexOf('@') + 1)
    .toLowerCase()
    .replace(/\.$/, '');
  return d || undefined;
}

/**
 * True when Cloudflare reports a pass bound to the From domain, strictly equal:
 * dmarc=pass with header.from, spf=pass with smtp.mailfrom, or dkim=pass with header.d.
 * A pass clause that names no domain (or another one) does not count.
 */
export function passesAuth(authResults: string | null, fromAddress: string): boolean {
  const r = trustedResults(authResults);
  if (!r) return false;
  const fromDomain = domainOf(fromAddress);
  if (!fromDomain) return false;
  const props: Record<string, string> = {
    dmarc: 'header\\.from',
    spf: 'smtp\\.mailfrom',
    dkim: 'header\\.d',
  };
  for (const clause of r.split(';').slice(1)) {
    for (const [method, prop] of Object.entries(props)) {
      if (!new RegExp(`^\\s*${method}=pass\\b`).test(clause)) continue;
      const m = new RegExp(`\\b${prop}=([^\\s;()]+)`).exec(clause);
      if (domainOf(m?.[1]) === fromDomain) return true;
    }
  }
  return false;
}
