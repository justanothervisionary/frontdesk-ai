// Shared by api/scrape-website.js - the one endpoint in this project that
// fetches a URL a visitor supplies, server-side. Any endpoint doing that is
// a classic SSRF vector (a malicious "website URL" pointing at an internal
// service, a cloud metadata endpoint, etc.), so this resolves the hostname
// to its real IP(s) and rejects private/reserved ranges - checking the
// hostname string alone isn't enough, since a public-looking domain can
// still resolve to an internal address.
const dns = require("dns").promises;

function ipToInt(ip) {
  var parts = ip.split(".").map(Number);
  return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inRange(ipInt, base, bits) {
  var mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (ipToInt(base) & mask);
}

// The ranges that matter here: loopback, private (RFC1918), link-local
// (includes the 169.254.169.254 cloud metadata address), and "this
// network" 0.0.0.0/8.
var PRIVATE_V4_RANGES = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]
];

function isPrivateV4(ip) {
  var ipInt = ipToInt(ip);
  return PRIVATE_V4_RANGES.some(function (r) { return inRange(ipInt, r[0], r[1]); });
}

function isPrivateV6(ip) {
  var lower = ip.toLowerCase();
  return lower === "::1" || lower.indexOf("fc") === 0 || lower.indexOf("fd") === 0 ||
    lower.indexOf("fe80") === 0 || lower.indexOf("::ffff:") === 0; // IPv4-mapped - re-check as v4 below if needed
}

// Throws if the URL isn't safe to fetch server-side. Returns nothing on
// success - callers just proceed to fetch() the same urlString afterward.
async function assertSafeToFetch(urlString) {
  var url;
  try {
    url = new URL(urlString);
  } catch (e) {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are supported.");
  }

  var addresses;
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch (e) {
    throw new Error("Could not resolve that domain.");
  }

  for (var i = 0; i < addresses.length; i++) {
    var addr = addresses[i];
    if (addr.family === 4 && isPrivateV4(addr.address)) {
      throw new Error("That address isn't reachable.");
    }
    if (addr.family === 6 && isPrivateV6(addr.address)) {
      throw new Error("That address isn't reachable.");
    }
  }
}

module.exports = { assertSafeToFetch };
