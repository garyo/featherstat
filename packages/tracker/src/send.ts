/**
 * Fire-and-forget delivery, shared by both trackers: `sendBeacon` survives
 * unload, `fetch` with `keepalive` covers browsers that lack it or refuse the
 * payload. The body goes out as the default `text/plain`, which never triggers
 * a CORS preflight — the collectors sniff bodies instead of trusting
 * `Content-Type` (docs/04 § 1), so nothing is lost by staying safelisted.
 */
export function send(url: string, body: string): void {
  try {
    if (navigator.sendBeacon(url, body)) return;
  } catch {
    // Oversized payloads and some privacy modes throw instead of returning false.
  }
  try {
    void fetch(url, {
      method: 'POST',
      body,
      keepalive: true,
      mode: 'no-cors',
      credentials: 'omit',
    }).catch(() => undefined);
  } catch {
    // No fetch either: the hit is dropped, never surfaced to the page.
  }
}
