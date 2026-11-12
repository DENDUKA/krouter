import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  updateProviderConnection,
} from "@/lib/localDb";
import { invalidateProviderQuotaCache } from "@/lib/integrations/providerQuotaCache";

const SAFE_PROVIDER_SPECIFIC_DATA_FIELDS = [
  "baseUrl",
  "azureEndpoint",
  "deployment",
  "apiVersion",
  "accountId",
  "region",
  "projectId",
  "resourceUrl",
  "proxyPoolId",
  "connectionProxyEnabled",
  "connectionProxyUrl",
  "connectionNoProxy",
  "githubLogin",
  "githubName",
  "githubEmail",
  "githubUserId",
  "username",
  "firstName",
  "lastName",
  "authMethod",
  "authKind",
];

function sanitizeConnection(connection) {
  if (!connection) return null;

  const result = { ...connection };
  delete result.apiKey;
  delete result.accessToken;
  delete result.refreshToken;
  delete result.idToken;

  if (connection.providerSpecificData) {
    result.providerSpecificData = {};
    for (const field of SAFE_PROVIDER_SPECIFIC_DATA_FIELDS) {
      if (connection.providerSpecificData[field] !== undefined) {
        result.providerSpecificData[field] = connection.providerSpecificData[field];
      }
    }
  }

  return result;
}

function logStatusChange({ connectionId, provider, isActive, result, error = null }) {
  console.info("[Integrations] Provider status change", {
    action: "provider_connection_status_update",
    connectionId,
    provider,
    isActive,
    result,
    ...(error ? { error } : {}),
  });
}

export async function PATCH(request, { params }) {
  let connectionId = null;
  let provider = null;
  let isActive = null;

  try {
    const routeParams = await params;
    connectionId = routeParams.connectionId;

    const body = await request.json();
    isActive = body?.isActive;

    if (typeof isActive !== "boolean") {
      logStatusChange({
        connectionId,
        provider,
        isActive,
        result: "validation_failed",
      });
      return NextResponse.json(
        { error: "isActive must be a boolean" },
        { status: 400 },
      );
    }

    const existing = await getProviderConnectionById(connectionId);
    if (!existing) {
      logStatusChange({
        connectionId,
        provider,
        isActive,
        result: "not_found",
      });
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 },
      );
    }

    provider = existing.provider;
    const updated = await updateProviderConnection(connectionId, { isActive });

    logStatusChange({
      connectionId,
      provider,
      isActive,
      result: "success",
    });

    invalidateProviderQuotaCache();

    return NextResponse.json({
      connection: sanitizeConnection(updated),
    });
  } catch (error) {
    logStatusChange({
      connectionId,
      provider,
      isActive,
      result: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Failed to update provider status" },
      { status: 500 },
    );
  }
}
