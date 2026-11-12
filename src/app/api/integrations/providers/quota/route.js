import "open-sse/index.js";

import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import {
  USAGE_APIKEY_PROVIDERS,
  USAGE_SUPPORTED_PROVIDERS,
} from "@/shared/constants/providers";
import {
  getCachedProviderQuotaResponse,
  getProviderQuotaCacheKey,
  setCachedProviderQuotaResponse,
} from "@/lib/integrations/providerQuotaCache";

function isQuotaEligible(connection) {
  return (
    USAGE_SUPPORTED_PROVIDERS.includes(connection.provider) &&
    (connection.authType === "oauth" ||
      USAGE_APIKEY_PROVIDERS.includes(connection.provider))
  );
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return "Failed to fetch provider usage";
}

function buildProviderResponse(connection, usage, error = null) {
  return {
    connectionId: connection.id,
    provider: connection.provider,
    name: connection.name,
    authType: connection.authType,
    isActive: connection.isActive === true,
    testStatus: connection.testStatus ?? null,
    quotaSupported: isQuotaEligible(connection),
    usage,
    error,
  };
}

async function buildProxyOptions(connection) {
  const proxyConfig = await resolveConnectionProxyConfig(
    connection.providerSpecificData,
  );

  return {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function fetchProviderUsage(connection) {
  if (connection.isActive !== true) {
    return buildProviderResponse(connection, null, null);
  }

  const proxyOptions = await buildProxyOptions(connection);
  const usage = await getUsageForProvider(connection, proxyOptions);
  return buildProviderResponse(connection, usage, null);
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const includeInactive = searchParams.get("includeInactive") === "true";
    const cacheKey = getProviderQuotaCacheKey({ includeInactive });

    const cached = getCachedProviderQuotaResponse(cacheKey);
    if (cached) {
      return NextResponse.json(cached);
    }

    const allConnections = await getProviderConnections();
    const eligibleConnections = allConnections.filter((connection) => {
      if (!isQuotaEligible(connection)) return false;
      if (includeInactive) return true;
      return connection.isActive === true;
    });

    const settled = await Promise.allSettled(
      eligibleConnections.map((connection) => fetchProviderUsage(connection)),
    );

    const response = {
      providers: settled.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        }

        return buildProviderResponse(
          eligibleConnections[index],
          null,
          toErrorMessage(result.reason),
        );
      }),
    };

    setCachedProviderQuotaResponse(cacheKey, response);
    return NextResponse.json(response);
  } catch (error) {
    console.error("[Integrations] Failed to fetch provider quota:", error);
    return NextResponse.json(
      { error: "Failed to fetch provider quota" },
      { status: 500 },
    );
  }
}
