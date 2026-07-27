# Matomo golden corpus

One JSON file per case; `matomo-corpus.test.ts` replays every file through the
real app and asserts the response plus the hits the sink received. This corpus
is a ratchet (CLAUDE.md invariant 6): add cases, never delete or weaken them.

```jsonc
{
  "name": "what this case pins down",     // required, shown in the test name
  "method": "GET",                        // GET | POST
  "path": "/matomo.php",                  // optional, default /matomo.php
  "query": "idsite=1&rec=1&…",            // raw query string, percent-encoded
  "body": "…",                            // optional POST body, verbatim
  "contentType": "application/json",      // optional request header
  "expectStatus": 200,                    // 200 + 1×1 GIF, or 204 for send_image=0
  "expectHits": [{ "siteId": 1, "type": "pageview" }]  // normalized Hit objects, in order
}
```

Real access-log lines are welcome — scrub IPs to documented test ranges
(`203.0.113.0/24`) before committing, and never include a raw IP
(CLAUDE.md invariant 3).
