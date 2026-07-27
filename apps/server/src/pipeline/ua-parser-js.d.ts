/**
 * ua-parser-js v1 ships no type declarations (v2 does, but was relicensed AGPL —
 * CLAUDE.md license discipline pins v1). Only the surface the pipeline uses is
 * declared here.
 */
declare module 'ua-parser-js' {
  export interface UAResult {
    ua: string;
    browser: { name?: string; version?: string; major?: string };
    os: { name?: string; version?: string };
    device: { type?: string; model?: string; vendor?: string };
  }
  export class UAParser {
    constructor(userAgent?: string);
    getResult(): UAResult;
  }
}
