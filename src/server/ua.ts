export type UaInfo = {
  /** Human-readable mail client / browser guess. */
  client: string;
  /** desktop | mobile | proxy | bot | unknown */
  device: "desktop" | "mobile" | "proxy" | "bot" | "unknown";
  /** True when the fetch came through a mail provider's image proxy. */
  isProxy: boolean;
};

/**
 * Best-effort parse of the User-Agent on a pixel fetch. Mail opens rarely carry
 * a rich UA — most arrive via provider image proxies — so this stays small and
 * pattern-based rather than pulling in a full UA library.
 */
export function parseUa(ua: string | null | undefined): UaInfo {
  const s = (ua ?? "").trim();
  if (!s) return { client: "unknown", device: "unknown", isProxy: false };

  const has = (re: RegExp) => re.test(s);

  // Provider image proxies (a real recipient open, fetched server-side).
  if (has(/GoogleImageProxy/i))
    return { client: "Gmail", device: "proxy", isProxy: true };
  if (has(/YahooMailProxy/i))
    return { client: "Yahoo Mail", device: "proxy", isProxy: true };
  if (has(/Outlook-(iOS|Android)/i))
    return { client: "Outlook Mobile", device: "mobile", isProxy: false };
  if (has(/BingPreview|microsoft|outlook\.com/i) && has(/proxy|imageproxy/i))
    return { client: "Outlook.com", device: "proxy", isProxy: true };
  if (has(/Proofpoint|Barracuda|Mimecast|GoDaddy|cloudmark/i))
    return { client: "Security scanner", device: "bot", isProxy: true };

  // Native desktop mail clients.
  if (has(/Microsoft Outlook/i))
    return { client: "Outlook (desktop)", device: "desktop", isProxy: false };
  if (has(/Thunderbird/i))
    return { client: "Thunderbird", device: "desktop", isProxy: false };
  if (has(/\bAppleWebKit\b/) && has(/\bMobile\b/) && has(/Mail/i))
    return { client: "Apple Mail (iOS)", device: "mobile", isProxy: false };

  // Apple Mail Privacy Protection proxies through iCloud with a Mac Safari-ish UA.
  if (has(/Macintosh/) && has(/Safari/) && !has(/Chrome|Firefox|Edg/))
    return { client: "Apple Mail", device: "desktop", isProxy: false };

  // Generic browsers (webmail rendered client-side, or "view in browser").
  if (has(/Edg\//)) return { client: "Edge", device: browserDevice(s), isProxy: false };
  if (has(/Chrome\//) && !has(/Chromium/))
    return { client: "Chrome", device: browserDevice(s), isProxy: false };
  if (has(/Firefox\//))
    return { client: "Firefox", device: browserDevice(s), isProxy: false };
  if (has(/Safari\//))
    return { client: "Safari", device: browserDevice(s), isProxy: false };
  if (has(/curl|wget|python-requests|Go-http|node-fetch|axios/i))
    return { client: "Script", device: "bot", isProxy: false };

  return { client: "unknown", device: "unknown", isProxy: false };
}

function browserDevice(s: string): "desktop" | "mobile" {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(s) ? "mobile" : "desktop";
}
