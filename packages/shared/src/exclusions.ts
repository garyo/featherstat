import { z } from 'zod';

/**
 * Traffic exclusion (docs/03 § Exclusions): addresses whose hits are dropped at
 * ingest so an operator's own browsing does not pollute their own numbers.
 *
 * A rule is matched against the client address the pipeline already holds in
 * memory; nothing new is persisted about a visitor, so invariant 3 (raw IP is
 * transient) is untouched. What IS stored is this list — the operator's OWN
 * addresses, entered by hand, which is configuration rather than observation.
 */

/** How many addresses one hostname may contribute before the rest are ignored. */
export const MAX_RESOLVED_PER_HOSTNAME = 16;

/** Rules per installation. Generous for a hand-maintained list, bounded so the hot-path scan stays short. */
export const MAX_EXCLUSION_RULES = 64;

/**
 * A hostname rather than a literal address — the answer for a dynamic IP, which
 * is the common case for an operator excluding their home network. Deliberately
 * stricter than the DNS grammar allows: labels are alphanumeric-with-hyphens,
 * at least two of them, no trailing dot. A value that looks at all like an
 * address is rejected here so it cannot silently become a hostname lookup.
 */
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type ExclusionRuleKind = 'address' | 'hostname';

/**
 * Which kind a value is, by shape alone; the parsers decide whether it is
 * actually valid. Disambiguation cannot go by character class — `abc.def` is
 * entirely hex digits and dots, yet it is plainly a hostname — so it goes by
 * structure instead: a prefix or a colon means an address, and otherwise only
 * all-numeric labels do.
 */
export function exclusionRuleKind(value: string): ExclusionRuleKind | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.includes('/') || trimmed.includes(':')) return 'address';
  const labels = trimmed.split('.');
  if (labels.every((label) => label !== '' && /^\d+$/.test(label))) return 'address';
  return HOSTNAME_RE.test(trimmed) ? 'hostname' : undefined;
}

export const ExclusionRuleSchema = z.object({
  /**
   * A literal address, a CIDR prefix, or a hostname resolved on a timer.
   * Lower-cased on the way in so the stored list matches what the matcher sees.
   */
  value: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .toLowerCase()
    .refine((v) => exclusionRuleKind(v) !== undefined, {
      message: 'expected an IP address, a CIDR prefix, or a hostname',
    }),
  /** Free text so a stale rule can be recognized months later ("home router"). */
  note: z.string().trim().max(120).default(''),
});
export type ExclusionRule = z.infer<typeof ExclusionRuleSchema>;

/**
 * `GET`/`PUT /api/admin/exclusions`. A PUT is a full replacement, like the other
 * admin settings; an empty list turns exclusion off.
 */
export const ExclusionSettingsSchema = z.object({
  rules: z.array(ExclusionRuleSchema).max(MAX_EXCLUSION_RULES),
});
export type ExclusionSettings = z.infer<typeof ExclusionSettingsSchema>;

/** What a hostname rule currently resolves to — read-only, for the settings view. */
export const ExclusionResolutionSchema = z.object({
  value: z.string(),
  /** Addresses the last successful lookup returned. */
  addresses: z.array(z.string()),
  /** When that lookup succeeded; null if none ever has. */
  resolvedAt: z.number().nullable(),
  /**
   * Why the most recent attempt failed, if it did. A rule keeps matching its
   * last-known-good addresses meanwhile — a DNS blip must not silently
   * re-admit the traffic the operator asked to drop.
   */
  error: z.string().nullable(),
});
export type ExclusionResolution = z.infer<typeof ExclusionResolutionSchema>;

/** `GET /api/admin/exclusions` — the rules plus what the resolver has made of them. */
export const ExclusionStateSchema = ExclusionSettingsSchema.extend({
  resolutions: z.array(ExclusionResolutionSchema),
});
export type ExclusionState = z.infer<typeof ExclusionStateSchema>;
