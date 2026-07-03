import { promises as dns } from "node:dns";
import net from "node:net";

export class UnsafeUrlError extends Error {
  code = "UNSAFE_URL";
}

function normalizedDomain(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string) {
  const value = address.toLowerCase().split("%")[0];
  if (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  ) {
    return true;
  }

  const mappedIpv4 = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
}

export function isPrivateIp(address: string) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export function validateTargetUrl(rawUrl: string, allowedDomain?: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("L’URL n’est pas valide.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new UnsafeUrlError("Seules les URLs HTTP et HTTPS sont acceptées.");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError(
      "Les URLs contenant des identifiants sont refusées.",
    );
  }
  if (
    url.port &&
    !(
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    )
  ) {
    throw new UnsafeUrlError("Le port de destination n’est pas autorisé.");
  }

  const hostname = normalizedDomain(url.hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new UnsafeUrlError("Les adresses locales sont refusées.");
  }

  if (allowedDomain) {
    const expected = normalizedDomain(allowedDomain);
    if (hostname !== expected && !hostname.endsWith(`.${expected}`)) {
      throw new UnsafeUrlError(`L’URL doit appartenir au domaine ${expected}.`);
    }
  }

  if (net.isIP(url.hostname) && isPrivateIp(url.hostname)) {
    throw new UnsafeUrlError("Les adresses IP privées sont refusées.");
  }

  return url;
}

export async function assertPublicResolution(url: URL) {
  if (net.isIP(url.hostname)) {
    if (isPrivateIp(url.hostname)) {
      throw new UnsafeUrlError("La destination résout vers une IP privée.");
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError("Le domaine ne peut pas être résolu.");
  }

  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateIp(address))
  ) {
    throw new UnsafeUrlError(
      "La destination résout vers une IP non autorisée.",
    );
  }
}
