/**
 * Edge-compatible helper for service-to-service auth via ROUTER_CONTROL_TOKEN.
 *
 * Designed to run in Next.js middleware / proxy runtime:
 * - No node:* imports, no crypto, no Buffer, no database layer.
 * - Uses only Request headers, strings, process.env and Web APIs.
 * - Constant-time string comparison via charCodeAt loop.
 */

function constantTimeStringEqual(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  let diff = expected.length ^ actual.length;
  const max = Math.max(expected.length, actual.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (expected.charCodeAt(i) || 0) ^ (actual.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Extract Bearer token from request Authorization header.
 * @param {Request} request
 * @returns {string | null}
 */
function extractBearerToken(request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const nodeToken = request.headers.get("x-orr-node-token");
  if (nodeToken) {
    return nodeToken.trim();
  }
  return null;
}

/**
 * Validate the request carries a valid router control token.
 *
 * @param {Request} request
 * @param {string} configuredToken
 * @returns {{ valid: boolean, configured: boolean }}
 *   - valid: true if token matches the configured token
 *   - configured: false if no token is set (auth disabled)
 */
export function validateRouterControlToken(request, configuredToken = process.env.ROUTER_CONTROL_TOKEN || "") {
  if (!configuredToken) {
    // No token configured — integration auth is disabled / not set up.
    return { valid: false, configured: false };
  }

  const bearerToken = extractBearerToken(request);
  if (!bearerToken) {
    return { valid: false, configured: true };
  }

  const valid = constantTimeStringEqual(configuredToken, bearerToken);
  return { valid, configured: true };
}
