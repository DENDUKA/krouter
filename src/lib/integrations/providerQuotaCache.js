const PROVIDER_QUOTA_CACHE_TTL_MS = 30 * 1000;

const providerQuotaCache = new Map();

export function getProviderQuotaCacheKey({ includeInactive = false } = {}) {
  return `providers-quota:includeInactive=${includeInactive ? "1" : "0"}`;
}

export function getCachedProviderQuotaResponse(cacheKey) {
  const cached = providerQuotaCache.get(cacheKey);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    providerQuotaCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

export function setCachedProviderQuotaResponse(
  cacheKey,
  value,
  ttlMs = PROVIDER_QUOTA_CACHE_TTL_MS,
) {
  providerQuotaCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + ttlMs,
  });

  return value;
}

export function invalidateProviderQuotaCache() {
  providerQuotaCache.clear();
}

export { PROVIDER_QUOTA_CACHE_TTL_MS };
