import { resolve4, resolve6 } from 'node:dns/promises';
import {
  type ExclusionResolution,
  type ExclusionRule,
  ExclusionSettingsSchema,
  exclusionRuleKind,
  MAX_RESOLVED_PER_HOSTNAME,
} from '@featherstat/shared';
import { type Db, getSetting, setSetting } from '../db/index.ts';

/**
 * Excluded-traffic matching (docs/03 § Exclusions). Addresses normalize to the
 * 16-byte IPv6 form — an IPv4 address becomes its IPv4-mapped equivalent — so
 * one comparison path serves both families and a v4 rule cannot silently miss a
 * v4-mapped client address.
 */

const V4_MAPPED_PREFIX_BITS = 96;
const V6_BITS = 128;

/** The `::ffff:0:0/96` lead-in every IPv4-mapped address carries. */
const V4_MAPPED_LEAD = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] as const;

function parseIpv4(value: string): Uint8Array | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(16);
  bytes.set(V4_MAPPED_LEAD);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i] as string;
    // Reject `01` and `+1`: a leading zero reads as octal to some parsers and
    // as decimal to others, and a rule that means different things to
    // different readers is worse than a rejected one.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    bytes[12 + i] = n;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | undefined {
  // A zone index (`fe80::1%eth0`) is link-local scoping, meaningless here.
  const bare = value.split('%')[0] as string;
  const halves = bare.split('::');
  if (halves.length > 2) return undefined;

  const readGroups = (text: string): number[] | undefined => {
    if (text === '') return [];
    const groups: number[] = [];
    for (const part of text.split(':')) {
      if (part.includes('.')) {
        // A trailing dotted quad (`::ffff:192.0.2.1`) occupies two groups.
        const v4 = parseIpv4(part);
        if (v4 === undefined) return undefined;
        groups.push(((v4[12] as number) << 8) | (v4[13] as number));
        groups.push(((v4[14] as number) << 8) | (v4[15] as number));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = readGroups(halves[0] as string);
  const tail = halves.length === 2 ? readGroups(halves[1] as string) : [];
  if (head === undefined || tail === undefined) return undefined;

  const total = head.length + tail.length;
  if (halves.length === 2 ? total > 7 : total !== 8) return undefined;

  const groups = [...head, ...new Array<number>(8 - total).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const group = groups[i] as number;
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/** A bare address in either family, normalized to 16 bytes. */
export function parseAddress(value: string): Uint8Array | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return undefined;
  return trimmed.includes(':') ? parseIpv6(trimmed) : parseIpv4(trimmed);
}

export interface Prefix {
  bytes: Uint8Array;
  bits: number;
}

/**
 * An address or CIDR prefix. An IPv4 prefix is shifted into mapped space (`/24`
 * becomes `/120`), which is what lets one matcher hold rules from both families.
 */
export function parsePrefix(value: string): Prefix | undefined {
  const trimmed = value.trim().toLowerCase();
  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    const bytes = parseAddress(trimmed);
    return bytes === undefined ? undefined : { bytes, bits: V6_BITS };
  }
  const head = trimmed.slice(0, slash);
  const bytes = parseAddress(head);
  if (bytes === undefined) return undefined;
  const isV4 = !head.includes(':');
  const declared = Number(trimmed.slice(slash + 1));
  if (!Number.isInteger(declared) || declared < 0) return undefined;
  if (declared > (isV4 ? 32 : V6_BITS)) return undefined;
  return { bytes, bits: isV4 ? declared + V4_MAPPED_PREFIX_BITS : declared };
}

/** Whether `address` falls inside `prefix`, comparing only the significant bits. */
export function prefixContains(prefix: Prefix, address: Uint8Array): boolean {
  const whole = prefix.bits >> 3;
  for (let i = 0; i < whole; i += 1) {
    if (prefix.bytes[i] !== address[i]) return false;
  }
  const remainder = prefix.bits & 7;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return ((prefix.bytes[whole] as number) & mask) === ((address[whole] as number) & mask);
}

/**
 * The compiled rule set the pipeline consults, plus the DNS state behind any
 * hostname rules. Rules are re-read from settings on change and hostnames
 * re-resolved on a timer — never on the hot path, which sees only a byte
 * comparison against a short list.
 */
export class ExclusionMatcher {
  private rules: readonly ExclusionRule[] = [];
  /** Literal prefixes, compiled once per rule change. */
  private literals: Prefix[] = [];
  /** Per-hostname resolver state, keyed by the rule value. */
  private readonly hosts = new Map<
    string,
    { addresses: Uint8Array[]; resolvedAt: number | null; error: string | null }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /** Replaces the rule set. Hostname state survives for values still present. */
  setRules(rules: readonly ExclusionRule[]): void {
    this.rules = rules;
    this.literals = [];
    const wanted = new Set<string>();
    for (const rule of rules) {
      if (exclusionRuleKind(rule.value) === 'hostname') {
        wanted.add(rule.value);
        if (!this.hosts.has(rule.value)) {
          this.hosts.set(rule.value, { addresses: [], resolvedAt: null, error: null });
        }
        continue;
      }
      const prefix = parsePrefix(rule.value);
      if (prefix !== undefined) this.literals.push(prefix);
    }
    for (const key of [...this.hosts.keys()]) {
      if (!wanted.has(key)) this.hosts.delete(key);
    }
  }

  /** True when nothing is configured — the pipeline skips the check entirely. */
  get empty(): boolean {
    return this.literals.length === 0 && this.hosts.size === 0;
  }

  /**
   * Whether this client address is excluded. Called once per request, so it
   * stays a byte scan over a bounded list with no allocation in the common
   * "nothing configured" case.
   */
  matches(ip: string): boolean {
    if (this.empty) return false;
    const address = parseAddress(ip);
    if (address === undefined) return false;
    for (const prefix of this.literals) {
      if (prefixContains(prefix, address)) return true;
    }
    for (const host of this.hosts.values()) {
      for (const candidate of host.addresses) {
        if (equalBytes(candidate, address)) return true;
      }
    }
    return false;
  }

  /** The hostnames needing a lookup, in rule order. */
  hostnames(): string[] {
    return [...this.hosts.keys()];
  }

  /**
   * Records a lookup result. A failure keeps the previous addresses: a DNS blip
   * must not quietly re-admit traffic the operator asked to drop, so the rule
   * goes on matching what it last knew while the error is surfaced.
   */
  setResolved(hostname: string, addresses: string[], error?: string): void {
    const host = this.hosts.get(hostname);
    if (host === undefined) return;
    if (error !== undefined) {
      host.error = error;
      return;
    }
    const parsed: Uint8Array[] = [];
    for (const value of addresses.slice(0, MAX_RESOLVED_PER_HOSTNAME)) {
      const bytes = parseAddress(value);
      if (bytes !== undefined) parsed.push(bytes);
    }
    host.addresses = parsed;
    host.resolvedAt = this.now();
    host.error = null;
  }

  /** What the settings view shows: each hostname rule and what it resolves to. */
  resolutions(): ExclusionResolution[] {
    return [...this.hosts.entries()].map(([value, host]) => ({
      value,
      addresses: host.addresses.map(formatAddress),
      resolvedAt: host.resolvedAt,
      error: host.error,
    }));
  }

  /** The current rules, for the admin read. */
  current(): readonly ExclusionRule[] {
    return this.rules;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 16; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Renders 16 bytes back for display — mapped addresses print as IPv4. */
export function formatAddress(bytes: Uint8Array): string {
  const mapped = V4_MAPPED_LEAD.every((byte, i) => bytes[i] === byte);
  if (mapped) return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push((((bytes[i * 2] as number) << 8) | (bytes[i * 2 + 1] as number)).toString(16));
  }
  return groups.join(':');
}

export type Resolver = (hostname: string) => Promise<string[]>;

/** A + AAAA together; either family answering alone is a success. */
export const dnsResolver: Resolver = async (hostname) => {
  const [v4, v6] = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses: string[] = [];
  if (v4.status === 'fulfilled') addresses.push(...v4.value);
  if (v6.status === 'fulfilled') addresses.push(...v6.value);
  if (addresses.length === 0) {
    const reason = v4.status === 'rejected' ? v4.reason : undefined;
    throw new Error(reason instanceof Error ? reason.message : 'no A or AAAA record');
  }
  return addresses;
};

/** Resolves every hostname rule once, recording successes and failures alike. */
export async function refreshResolutions(
  matcher: ExclusionMatcher,
  resolver: Resolver = dnsResolver,
): Promise<void> {
  await Promise.all(
    matcher.hostnames().map(async (hostname) => {
      try {
        matcher.setResolved(hostname, await resolver(hostname));
      } catch (error) {
        matcher.setResolved(hostname, [], error instanceof Error ? error.message : String(error));
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Storage + the refresh timer
// ---------------------------------------------------------------------------

export const EXCLUSION_RULES_KEY = 'exclusion_rules';

/**
 * How often hostname rules are re-resolved. A dynamic address changes on the
 * order of days, so this only bounds how long the operator's own hits leak in
 * after one moves — short enough not to matter, long enough to be invisible
 * next to the DNS TTL.
 */
export const EXCLUSION_REFRESH_MS = 5 * 60_000;

/**
 * A row we cannot validate excludes NOTHING rather than guessing. The failure
 * that matters here is the reverse of alerts': dropping real traffic on a
 * malformed rule would lose data that cannot be recovered, while recording a
 * few of the operator's own hits is merely untidy.
 */
export function readExclusionRules(
  db: Db,
  warn: (line: string) => void = console.warn,
): ExclusionRule[] {
  const raw = getSetting(db, EXCLUSION_RULES_KEY);
  if (raw === undefined) return [];
  try {
    const parsed = ExclusionSettingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.rules;
    warn(`${EXCLUSION_RULES_KEY} is not a valid rule list — traffic exclusion is off`);
  } catch {
    warn(`${EXCLUSION_RULES_KEY} is not valid JSON — traffic exclusion is off`);
  }
  return [];
}

/** Runs inside the caller's write transaction (docs/02 single writer). */
export function writeExclusionRules(db: Db, rules: readonly ExclusionRule[]): void {
  setSetting(db, EXCLUSION_RULES_KEY, JSON.stringify({ rules }));
}

export interface ExclusionRefresh {
  /** Resolves every hostname rule now — the admin route awaits this after a write. */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Keeps hostname rules resolved on a timer, off the hot path entirely: ingest
 * only ever reads the address set this maintains. The timer is unref'd so it
 * cannot hold the process open on shutdown.
 */
export function startExclusionRefresh(
  matcher: ExclusionMatcher,
  options: { intervalMs?: number; resolver?: Resolver; onError?: (error: unknown) => void } = {},
): ExclusionRefresh {
  const { intervalMs = EXCLUSION_REFRESH_MS, resolver = dnsResolver } = options;
  const onError = options.onError ?? ((error) => console.error('exclusion refresh failed:', error));
  const refresh = async (): Promise<void> => {
    try {
      await refreshResolutions(matcher, resolver);
    } catch (error) {
      onError(error);
    }
  };
  const timer = setInterval(() => void refresh(), intervalMs);
  timer.unref?.();
  void refresh();
  return { refresh, stop: () => clearInterval(timer) };
}
