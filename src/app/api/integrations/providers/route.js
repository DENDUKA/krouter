import { NextResponse } from "next/server";
import { getProviderConnections, getProviderNodes } from "@/models";
import {
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

function hideSecrets(connection, nodeNameMap) {
  const isCompatible =
    isOpenAICompatibleProvider(connection.provider) ||
    isAnthropicCompatibleProvider(connection.provider);

  const name = isCompatible
    ? (connection.name ||
      nodeNameMap[connection.provider] ||
      connection.providerSpecificData?.nodeName ||
      connection.provider)
    : connection.name;

  return {
    ...connection,
    name,
    apiKey: undefined,
    accessToken: undefined,
    refreshToken: undefined,
    idToken: undefined,
  };
}

export async function GET() {
  try {
    const connections = await getProviderConnections();
    const nodeNameMap = {};

    try {
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node.id && node.name) {
          nodeNameMap[node.id] = node.name;
        }
      }
    } catch {
    }

    return NextResponse.json({
      connections: connections.map((connection) => hideSecrets(connection, nodeNameMap)),
    });
  } catch (error) {
    console.log("[Integrations] Failed to fetch providers:", error);
    return NextResponse.json(
      { error: "Failed to fetch providers" },
      { status: 500 },
    );
  }
}
