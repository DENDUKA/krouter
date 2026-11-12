import { NextResponse } from "next/server";
import { getProviderConnections, getCustomModels, getModelAliases, getProviderNodes } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { fetchProviderModelsForConnection } from "@/app/api/providers/[id]/models/route";
import { PROVIDER_ID_TO_ALIAS, getModelsByProviderId } from "@/shared/constants/models";
import {
  ID_TO_ALIAS,
  getProviderAlias,
  resolveProviderId,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

const CANONICAL_PROVIDER_IDS = new Set(["minimax", "minimax-cn", "codex", "claude"]);
const SUPPORTED_SOURCES = new Set(["static", "effective", "dynamic", "all"]);
const DYNAMIC_CANONICAL_PROVIDER_IDS = new Set(["codex", "claude"]);
const COMPATIBLE_LLM_NODE_TYPES = new Set(["openai-compatible", "anthropic-compatible"]);
const DEFAULT_MODEL_TYPE = "llm";

function isCompatibleLlmProviderId(providerId) {
  return isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
}

function supportsDynamic(providerId) {
  if (DYNAMIC_CANONICAL_PROVIDER_IDS.has(providerId)) return true;
  return isCompatibleLlmProviderId(providerId);
}

async function resolveCompatibleNode(providerKey) {
  let nodes;
  try {
    nodes = await getProviderNodes();
  } catch (error) {
    console.log("Failed to load provider nodes for integrations provider models:", error);
    return { error: { status: 500, message: "Failed to load provider nodes" } };
  }

  const llmNodes = nodes.filter((node) => COMPATIBLE_LLM_NODE_TYPES.has(node?.type));
  const prefixMatches = llmNodes.filter(
    (node) => typeof node?.prefix === "string" && node.prefix.trim().toLowerCase() === providerKey,
  );

  if (prefixMatches.length > 1) {
    return { error: { status: 409, message: "Ambiguous provider prefix" } };
  }
  if (prefixMatches.length === 1) {
    const node = prefixMatches[0];
    return { node, providerId: node.id, alias: node.prefix, nodeType: node.type };
  }

  const idMatch = llmNodes.find((node) => typeof node?.id === "string" && node.id.toLowerCase() === providerKey);
  if (idMatch) {
    return { node: idMatch, providerId: idMatch.id, alias: idMatch.prefix, nodeType: idMatch.type };
  }

  const embeddingMatch = nodes.find(
    (node) =>
      node?.type === "custom-embedding" &&
      ((typeof node?.prefix === "string" && node.prefix.trim().toLowerCase() === providerKey) ||
        (typeof node?.id === "string" && node.id.toLowerCase() === providerKey)),
  );
  if (embeddingMatch) {
    return {
      error: {
        status: 404,
        message:
          "Embedding-only provider; use /api/integrations/providers/by-type/{provider}/embeddings (not implemented yet)",
      },
    };
  }

  return null;
}

async function normalizeProviderParam(rawProvider, { includeCompatible }) {
  const providerKey = typeof rawProvider === "string" ? rawProvider.trim().toLowerCase() : "";
  if (!providerKey) return null;

  const providerId = resolveProviderId(providerKey);
  if (CANONICAL_PROVIDER_IDS.has(providerId)) {
    const alias = ID_TO_ALIAS[providerId] || getProviderAlias(providerId) || PROVIDER_ID_TO_ALIAS[providerId] || providerId;
    return { providerId, alias, nodeType: null };
  }

  if (!includeCompatible) return null;

  return resolveCompatibleNode(providerKey);
}

function parseBooleanParam(searchParams, name) {
  const raw = searchParams.get(name);
  if (raw == null) return false;
  return raw.trim().toLowerCase() === "true";
}

function normalizeSource(searchParams) {
  const rawSource = searchParams.get("source");
  if (!rawSource) return "effective";
  return rawSource.trim().toLowerCase();
}

function normalizeOutputAlias(connection, fallbackAlias) {
  const prefix = connection?.providerSpecificData?.prefix;
  if (typeof prefix === "string" && prefix.trim()) return prefix.trim();
  return fallbackAlias;
}

function normalizeModelId(modelId, aliases) {
  if (typeof modelId !== "string") return null;
  const trimmed = modelId.trim();
  if (!trimmed) return null;

  for (const alias of aliases) {
    if (!alias) continue;
    const prefix = `${alias}/`;
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length) || null;
    }
  }

  return trimmed;
}

function getStaticModelMetadata(providerId) {
  const staticModels = getModelsByProviderId(providerId);
  const modelById = new Map(
    staticModels.map((model) => [
      model.id,
      {
        name: model.name || model.id,
        type: model.type || DEFAULT_MODEL_TYPE,
      },
    ]),
  );

  return { staticModels, modelById };
}

function isDisabled(disabledByAlias, aliases, modelId) {
  return aliases.some(
    (alias) => Array.isArray(disabledByAlias?.[alias]) && disabledByAlias[alias].includes(modelId),
  );
}

function makeModelEntry({ modelId, publicAlias, staticModelById, enabled = true }) {
  const staticModel = staticModelById.get(modelId);
  return {
    id: modelId,
    publicId: `${publicAlias}/${modelId}`,
    name: staticModel?.name || modelId,
    type: staticModel?.type || DEFAULT_MODEL_TYPE,
    enabled,
  };
}

async function loadDisabledModelsSafe(warnings) {
  try {
    return await getDisabledModels();
  } catch (error) {
    warnings.push("Не удалось загрузить disabled models; используется enabled=true без глобальной фильтрации.");
    console.log("Failed to load disabled models for integrations provider models:", error);
    return null;
  }
}

async function loadCustomModelsSafe(warnings) {
  try {
    return await getCustomModels();
  } catch (error) {
    warnings.push("Не удалось загрузить custom models; они не включены в ответ.");
    console.log("Failed to load custom models for integrations provider models:", error);
    return [];
  }
}

async function loadModelAliasesSafe(warnings) {
  try {
    return await getModelAliases();
  } catch (error) {
    warnings.push("Не удалось загрузить model aliases; alias models не включены в ответ.");
    console.log("Failed to load model aliases for integrations provider models:", error);
    return {};
  }
}

function buildStaticModels(providerId, alias, disabledByAlias) {
  const { staticModels, modelById } = getStaticModelMetadata(providerId);
  const disabledAliases = [alias, providerId];

  return staticModels.map((model) =>
    makeModelEntry({
      modelId: model.id,
      publicAlias: alias,
      staticModelById: modelById,
      enabled: disabledByAlias ? !isDisabled(disabledByAlias, disabledAliases, model.id) : true,
    }),
  );
}

function buildEffectiveModelsForConnection({
  connection,
  providerId,
  alias,
  staticModelById,
  disabledByAlias,
  customModels,
  modelAliases,
}) {
  const outputAlias = normalizeOutputAlias(connection, alias);
  const scopeAliases = [outputAlias, alias, providerId];
  const enabledModels = connection?.providerSpecificData?.enabledModels;
  const rawModelIds =
    Array.isArray(enabledModels) && enabledModels.length > 0
      ? enabledModels
      : getModelsByProviderId(providerId).map((model) => model.id);

  const normalizedStaticIds = rawModelIds
    .map((modelId) => normalizeModelId(modelId, scopeAliases))
    .filter(Boolean);

  const customModelIds = customModels
    .filter((model) => {
      if (!model?.providerAlias || !model?.id) return false;
      if (model.type && model.type !== DEFAULT_MODEL_TYPE) return false;
      return scopeAliases.includes(model.providerAlias);
    })
    .map((model) => normalizeModelId(String(model.id), scopeAliases))
    .filter(Boolean);

  const aliasModelIds = Object.values(modelAliases)
    .filter((fullModel) => {
      if (typeof fullModel !== "string" || !fullModel.includes("/")) return false;
      return scopeAliases.some((candidate) => fullModel.startsWith(`${candidate}/`));
    })
    .map((fullModel) => normalizeModelId(fullModel, scopeAliases))
    .filter(Boolean);

  const mergedModelIds = Array.from(new Set([...normalizedStaticIds, ...customModelIds, ...aliasModelIds]));

  return mergedModelIds
    .filter((modelId) => (disabledByAlias ? !isDisabled(disabledByAlias, scopeAliases, modelId) : true))
    .map((modelId) => makeModelEntry({
      modelId,
      publicAlias: outputAlias,
      staticModelById,
      enabled: true,
    }));
}

async function resolveDynamicModels(providerId, alias, activeConnections) {
  if (!supportsDynamic(providerId)) {
    return {
      error: `Provider ${providerId} does not support dynamic models listing`,
      status: 501,
    };
  }

  if (activeConnections.length === 0) {
    return {
      provider: providerId,
      alias,
      source: "dynamic",
      models: [],
      warning: "Нет активных connections для dynamic source.",
    };
  }

  let lastFailure = null;
  for (const connection of activeConnections) {
    const result = await fetchProviderModelsForConnection(connection);
    if (result.error) {
      lastFailure = result;
      continue;
    }

    const outputAlias = normalizeOutputAlias(connection, alias);
    const models = (result.models || [])
      .map((model) => {
        const modelId = normalizeModelId(
          model?.id || model?.name || model?.model,
          [outputAlias, alias, providerId],
        );
        if (!modelId) return null;
        return {
          id: modelId,
          publicId: `${outputAlias}/${modelId}`,
          name: model?.name || model?.display_name || model?.displayName || modelId,
          type: model?.type || DEFAULT_MODEL_TYPE,
          enabled: true,
        };
      })
      .filter(Boolean);

    return {
      provider: providerId,
      alias,
      source: "dynamic",
      connectionId: connection.id,
      models,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  return {
    error: lastFailure?.error || "Failed to fetch dynamic models",
    status: lastFailure?.status || 502,
  };
}

function mergeAllSourceModels(sourceModels) {
  const merged = new Map();

  for (const [sourceName, models] of sourceModels) {
    for (const model of models) {
      const current = merged.get(model.publicId);
      if (!current) {
        merged.set(model.publicId, {
          ...model,
          sources: [sourceName],
        });
        continue;
      }

      current.sources = Array.from(new Set([...current.sources, sourceName]));
      current.enabled = current.enabled || model.enabled;
      if ((!current.name || current.name === current.id) && model.name) {
        current.name = model.name;
      }
      if ((!current.type || current.type === DEFAULT_MODEL_TYPE) && model.type) {
        current.type = model.type;
      }
    }
  }

  return Array.from(merged.values());
}

export async function GET(request, { params }) {
  try {
    const { provider } = await params;
    const url = new URL(request.url);
    const includeCompatible = parseBooleanParam(url.searchParams, "includeCompatible");
    const normalized = await normalizeProviderParam(provider, { includeCompatible });
    if (!normalized) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }
    if (normalized.error) {
      return NextResponse.json({ error: normalized.error.message }, { status: normalized.error.status });
    }

    const source = normalizeSource(url.searchParams);
    if (!SUPPORTED_SOURCES.has(source)) {
      return NextResponse.json({ error: "Unsupported source" }, { status: 400 });
    }

    const { providerId, alias, nodeType } = normalized;
    const isCompatibleNode = Boolean(nodeType);
    const baseResponse = {
      provider: providerId,
      alias,
      ...(nodeType ? { nodeType } : {}),
    };
    const warnings = [];
    const disabledByAlias = await loadDisabledModelsSafe(warnings);

    if (source === "static") {
      const models = isCompatibleNode ? [] : buildStaticModels(providerId, alias, disabledByAlias);
      if (isCompatibleNode) {
        warnings.push("Compatible node has no static catalog; use source=effective or source=dynamic.");
      }
      return NextResponse.json({
        ...baseResponse,
        source,
        models,
        ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      });
    }

    let connections;
    try {
      connections = await getProviderConnections();
    } catch (error) {
      console.log("Failed to load provider connections for integrations provider models:", error);
      return NextResponse.json({ error: "Failed to load provider connections" }, { status: 500 });
    }

    const activeConnections = connections.filter(
      (connection) => connection.provider === providerId && connection.isActive !== false,
    );

    if (source === "dynamic") {
      const dynamicResult = await resolveDynamicModels(providerId, alias, activeConnections);
      if (dynamicResult.error) {
        return NextResponse.json({ error: dynamicResult.error }, { status: dynamicResult.status || 500 });
      }
      if (warnings.length > 0 && !dynamicResult.warning) {
        dynamicResult.warning = warnings.join(" ");
      } else if (warnings.length > 0 && dynamicResult.warning) {
        dynamicResult.warning = `${dynamicResult.warning} ${warnings.join(" ")}`;
      }
      if (nodeType) dynamicResult.nodeType = nodeType;
      return NextResponse.json(dynamicResult);
    }

    const { modelById } = getStaticModelMetadata(providerId);

    if (source === "effective") {
      const customModels = await loadCustomModelsSafe(warnings);
      const modelAliases = await loadModelAliasesSafe(warnings);
      const models = activeConnections.flatMap((connection) =>
        buildEffectiveModelsForConnection({
          connection,
          providerId,
          alias,
          staticModelById: modelById,
          disabledByAlias,
          customModels,
          modelAliases,
        }),
      );

      const dedupedModels = Array.from(
        new Map(models.map((model) => [model.publicId, model])).values(),
      );

      return NextResponse.json({
        ...baseResponse,
        source,
        models: dedupedModels,
        ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      });
    }

    const staticModels = isCompatibleNode ? [] : buildStaticModels(providerId, alias, disabledByAlias);
    if (isCompatibleNode) {
      warnings.push("Compatible node has no static catalog; static source is empty.");
    }
    const customModels = await loadCustomModelsSafe(warnings);
    const modelAliases = await loadModelAliasesSafe(warnings);
    const effectiveModels = activeConnections.flatMap((connection) =>
      buildEffectiveModelsForConnection({
        connection,
        providerId,
        alias,
        staticModelById: modelById,
        disabledByAlias,
        customModels,
        modelAliases,
      }),
    );

    const sourceModels = [
      ["static", staticModels],
      ["effective", Array.from(new Map(effectiveModels.map((model) => [model.publicId, model])).values())],
    ];

    const dynamicResult = await resolveDynamicModels(providerId, alias, activeConnections);
    if (dynamicResult.error) {
      warnings.push(dynamicResult.error);
    } else {
      if (dynamicResult.warning) warnings.push(dynamicResult.warning);
      sourceModels.push(["dynamic", dynamicResult.models]);
    }

    return NextResponse.json({
      ...baseResponse,
      source,
      models: mergeAllSourceModels(sourceModels),
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
    });
  } catch (error) {
    console.log("Error fetching integration provider models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}
