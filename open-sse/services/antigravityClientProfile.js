// antigravityClientProfile (0.5.29) — slimmed port of OmniRoute's
// antigravityClientProfile.
//
// Different client "profiles" present different header sets to Antigravity.
// Picking the right profile makes traffic look like a known native client
// (the VS Code IDE extension, the standalone harness, or the credit probe).
//
// Profiles:
//   "ide"        — VS Code Antigravity extension (default — most generic)
//   "harness"    — Antigravity standalone CLI/harness (server contexts)
//   "credit-probe" — quota/credit fetch (small, identifiable)
//
// Operators can pin a connection to a specific profile via
// providerSpecificData.clientProfile. Default = "ide".
//
// Pure functions — no external deps.

const VALID_PROFILES = new Set(["ide", "harness", "credit-probe"]);
export const DEFAULT_ANTIGRAVITY_CLIENT_PROFILE = "ide";

export function normalizeAntigravityClientProfile(value) {
  if (typeof value === "string" && VALID_PROFILES.has(value)) return value;
  return DEFAULT_ANTIGRAVITY_CLIENT_PROFILE;
}

export function getAntigravityClientProfile(credentials) {
  const fromPSD = credentials?.providerSpecificData?.clientProfile;
  return normalizeAntigravityClientProfile(fromPSD);
}

const RUNTIME_PLATFORM = (() => {
  switch (process.platform) {
    case "win32": return "windows";
    case "darwin": return "darwin";
    case "linux": return "linux";
    default: return process.platform || "unknown";
  }
})();

const RUNTIME_ARCH = (() => {
  switch (process.arch) {
    case "x64": return "amd64";
    case "ia32": return "386";
    case "arm64": return "arm64";
    default: return process.arch || "unknown";
  }
})();

// 2026-11-17 — pinned to the desktop app build the header format is copied from.
// The full `aidev_client` User-Agent (see appConstants.getAntigravityUserAgent)
// is what unlocks the Gemini 4 roster; the short forms below are only kept for
// the non-chat profiles, which never list models.
export const ANTIGRAVITY_APP_VERSION = "2.32.1";

// Stable per-process version. Pull from package.json if available.
let _cachedVersion = ANTIGRAVITY_APP_VERSION;
export function setAntigravityCachedVersion(v) {
  if (typeof v === "string" && v.length > 0) _cachedVersion = v;
}
export function getAntigravityCachedVersion() {
  return _cachedVersion;
}

function ideHeaders(accessToken) {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": `antigravity/${ANTIGRAVITY_APP_VERSION}.0 (aidev_client; os_type=${RUNTIME_PLATFORM}; arch=${RUNTIME_ARCH}; cl=1003475615)`,
    "X-Client-Name": "antigravity",
    "X-Client-Version": ANTIGRAVITY_APP_VERSION,
    "x-request-source": "local",
  };
}

function harnessHeaders(accessToken) {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": `antigravity/${ANTIGRAVITY_APP_VERSION}.0 (aidev_client; os_type=${RUNTIME_PLATFORM}; arch=${RUNTIME_ARCH}; cl=1003475615)`,
    "X-Client-Name": "antigravity-harness",
    "X-Client-Version": ANTIGRAVITY_APP_VERSION,
    "x-request-source": "local",
  };
}

function creditProbeHeaders(accessToken) {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "antigravity-credit-probe",
    "X-Client-Name": "antigravity",
    "X-Client-Version": ANTIGRAVITY_APP_VERSION,
    "x-request-source": "local",
  };
}

// Resolve the header set for a given profile + access token.
// Operator can call this from any place that needs to build outbound
// Antigravity headers — keeps the profile-switching logic in one place.
export function getAntigravityProfileHeaders(profile, accessToken) {
  switch (normalizeAntigravityClientProfile(profile)) {
    case "harness": return harnessHeaders(accessToken);
    case "credit-probe": return creditProbeHeaders(accessToken);
    case "ide":
    default: return ideHeaders(accessToken);
  }
}

// Convenience: full headers for a credentials object (auto-picks profile).
export function getAntigravityHeadersForCredentials(credentials) {
  const profile = getAntigravityClientProfile(credentials);
  const token = credentials?.accessToken;
  return getAntigravityProfileHeaders(profile, token);
}

export const ANTIGRAVITY_CLIENT_PROFILE_VALUES = Array.from(VALID_PROFILES);
