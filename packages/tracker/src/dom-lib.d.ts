/// <reference lib="dom" />

// The repo tsconfig targets Node (server, shared) and ships no DOM lib; the
// tracker is the one package that runs in a browser, so it pulls the lib in.

interface Document {
  /**
   * True while speculation rules are prerendering this document (prerender.ts).
   * Optional because a browser that does not prerender never defines it, and
   * that absence is exactly what the guard reads.
   */
  readonly prerendering?: boolean;
}
