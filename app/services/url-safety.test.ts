import { describe, expect, it } from "vitest";
import {
  isPrivateIp,
  UnsafeUrlError,
  validateTargetUrl,
} from "./url-safety.server";

describe("URL safety", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.2",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
  ])("blocks private address %s", (address) => {
    expect(isPrivateIp(address)).toBe(true);
  });

  it("accepts the competitor domain and subdomains", () => {
    expect(
      validateTargetUrl(
        "https://www.bourgognearcherie.com/product/1",
        "bourgognearcherie.com",
      ).hostname,
    ).toBe("www.bourgognearcherie.com");
  });

  it("rejects a different domain", () => {
    expect(() =>
      validateTargetUrl(
        "https://example.com/product/1",
        "bourgognearcherie.com",
      ),
    ).toThrow(UnsafeUrlError);
  });

  it.each([
    "file:///etc/passwd",
    "http://localhost/admin",
    "http://127.0.0.1/admin",
    "https://user:password@example.com",
    "https://example.com:8443/product",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validateTargetUrl(url)).toThrow(UnsafeUrlError);
  });
});
