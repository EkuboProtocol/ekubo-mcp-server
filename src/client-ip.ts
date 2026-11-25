/**
 * The public IP of the browser that sent this request, in the canonical form
 * on-ramp providers compare against: dotted-quad IPv4 without leading zeros,
 * RFC 5952 IPv6, and IPv4-mapped IPv6 unmapped. Null when Cloudflare supplied
 * no usable address.
 */
export function clientIp(request: Request): string | null {
  const headers = request.headers;
  const candidates = [headers.get("true-client-ip"), headers.get("cf-connecting-ip")];
  for (const candidate of candidates) {
    const canonical = canonicalIp(candidate);
    if (canonical === null) continue;
    // Cloudflare's pseudo IPv4 (240.0.0.0/4) stands in for an IPv6 client.
    if (isPseudoIpv4(canonical)) return canonicalIp(headers.get("cf-connecting-ipv6"));
    return canonical;
  }
  return null;
}

export function canonicalIp(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^[0-9.]+$/.test(trimmed)) return canonicalIpv4(trimmed);
  if (!/^[0-9a-fA-F:.]+$/.test(trimmed) || !trimmed.includes(":")) return null;
  let host: string;
  try {
    host = new URL(`http://[${trimmed}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped !== null) {
    const high = parseInt(mapped[1]!, 16);
    const low = parseInt(mapped[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return host;
}

function canonicalIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^[0-9]{1,3}$/.test(part) ? Number(part) : NaN));
  if (octets.some((octet) => !(octet >= 0 && octet <= 255))) return null;
  return octets.join(".");
}

function isPseudoIpv4(ip: string): boolean {
  const first = Number(ip.split(".")[0]);
  return ip.includes(".") && first >= 240 && first <= 255;
}
