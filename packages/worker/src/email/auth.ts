/**
 * Sender authentication from the Authentication-Results header that Cloudflare
 * Email Routing prepends before invoking the Worker.
 * https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#authentication-results
 */

/** Extracts the bare address from a From header value, lowercased. Null if none. */
export function senderAddress(from: string | null): string | null {
  if (!from) return null;
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  const bare = angled ? angled[1] : /([^\s<>",;]+@[^\s<>",;]+)/.exec(from)?.[1];
  return bare ? bare.toLowerCase() : null;
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

function aligned(domain: string | undefined, fromDomain: string): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return d === fromDomain || d.endsWith(`.${fromDomain}`) || fromDomain.endsWith(`.${d}`);
}

/**
 * True when Cloudflare reports the message passed authentication for the From domain:
 * dmarc=pass (SPF or DKIM aligned with From), or spf=pass / dkim=pass whose reported
 * domain (smtp.mailfrom / header.d) matches the From domain. A bare spf=pass with no
 * domain is not enough, since it only vouches for the envelope sender.
 */
export function passesAuth(authResults: string | null, fromAddress: string): boolean {
  const r = trustedResults(authResults);
  if (!r) return false;
  const fromDomain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1);
  if (/\bdmarc=pass\b/.test(r)) return true;
  const spf = /\bspf=pass\b[^;]*?smtp\.mailfrom=(?:[^@\s;]*@)?([^\s;()]+)/.exec(r);
  if (spf && aligned(spf[1], fromDomain)) return true;
  const dkim = /\bdkim=pass\b[^;]*?header\.(?:d|i)=(?:[^@\s;]*@)?([^\s;()]+)/.exec(r);
  return !!dkim && aligned(dkim[1], fromDomain);
}
