/** Extensions that make a link a download rather than a navigation (Matomo's list, trimmed). */
const DOWNLOAD_EXTENSION =
  /\.(7z|aac|apk|avi|bz2|csv|deb|dmg|docx?|epub|exe|flac|flv|gz|gzip|ipa|iso|jar|m4[av]|mkv|mobi|mp[234]|mpe?g|mov|msi|odp|ods|odt|ogg|ogv|pdf|pptx?|rar|rpm|rtf|sit|tar|tbz2?|tgz|torrent|txt|wav|webm|wma|wmv|xlsx?|xz|zip)$/i;

export interface LinkTarget {
  kind: 'link' | 'download';
  /** The absolute destination, as sent to the collector. */
  url: string;
}

/**
 * Classify a clicked destination: a file extension (or a `download` attribute)
 * makes it a download, a different host makes it an outlink, and anything else
 * is ordinary navigation that the pageview on the next page already records.
 */
export function classifyLink(
  href: string,
  hostname: string,
  download = false,
): LinkTarget | undefined {
  let target: URL;
  try {
    target = new URL(href);
  } catch {
    return undefined;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return undefined;
  if (download || DOWNLOAD_EXTENSION.test(target.pathname)) {
    return { kind: 'download', url: target.href };
  }
  return target.hostname === hostname ? undefined : { kind: 'link', url: target.href };
}

const MIDDLE_BUTTON = 1;

/**
 * Whether a click on a link is the visitor following it. `click` is the primary
 * button, modifier keys included; every other button arrives as `auxclick`, and
 * of those only the middle one opens anything — a right click opens a context
 * menu, which is not leaving.
 */
export function isLinkActivation(event: Event): boolean {
  return event.type === 'click' || (event as MouseEvent).button === MIDDLE_BUTTON;
}
