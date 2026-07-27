/// <reference lib="dom" />

// The repo tsconfig targets Node (server, shared) and ships no DOM lib; the
// tracker is the one package that runs in a browser, so it pulls the lib in.
