// The tracker is the one package that runs in a browser, so it alone compiles
// against the DOM lib (packages/tracker/tsconfig.json); the root program, which
// covers the server and shared code, has none.

interface Document {
  /**
   * True while speculation rules are prerendering this document (prerender.ts).
   * Optional because a browser that does not prerender never defines it, and
   * that absence is exactly what the guard reads.
   */
  readonly prerendering?: boolean;
}
