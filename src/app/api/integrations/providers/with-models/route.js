import { NextResponse } from "next/server";
import { getProviderConnections, getCustomModels, getModelAliases, getCombos } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { ID_TO_ALIAS, getProviderAlias, AI_PROVIDERS, THINKING_CONFIG } from "@/shared/constants/providers";
import { fetchProviderModelsForConnection } from "@/app/api/providers/[id]/models/route";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";

export const dynamic = "force-dynamic";

const DEFAULT_MODEL_TYPE = "llm";

function normalizeModelId(modelId, aliases) {
  if (typeof modelId !== "string") return null;
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  for (const alias of aliases) {
    if (!alias) continue;
    const prefix = `${alias}/`;
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length) || null;
  }
  return trimmed;
}

function normalizeOutputAlias(connection, fallbackAlias) {
  const prefix = connection?.providerSpecificData?.prefix;
  if (typeof prefix === "string" && prefix.trim()) return prefix.trim();
  return fallbackAlias;
}

function isDisabled(disabledByAlias, aliases, modelId) {
  return aliases.some(
    (alias) => Array.isArray(disabledByAlias?.[alias]) && disabledByAlias[alias].includes(modelId),
  );
}

function resolveThinkingOptions(thinkingFormat) {
  if (!thinkingFormat) return [];
  const extendedFormats = ["claude-adaptive", "gemini-level"];
  return extendedFormats.includes(thinkingFormat)
    ? THINKING_CONFIG.extended.options
    : THINKING_CONFIG.effort.options;
}

function connectionAliases(connection) {
  const providerId = connection?.provider;
  if (typeof providerId !== "string" || !providerId) return [];

  const alias =
    ID_TO_ALIAS[providerId] ||
    getProviderAlias(providerId) ||
    PROVIDER_ID_TO_ALIAS[providerId] ||
    providerId;

  return Array.from(new Set([
    providerId,
    alias,
    normalizeOutputAlias(connection, alias),
  ].filter(Boolean)));
}

function comboReasoningMember(modelId, providerByAlias) {
  const memberId = typeof modelId === "string" ? modelId.trim() : "";
  const separator = memberId.indexOf("/");
  if (separator <= 0 || separator === memberId.length - 1) {
    return { modelId: memberId, reasoningEfforts: [] };
  }

  const providerAlias = memberId.slice(0, separator);
  const upstreamModelId = memberId.slice(separator + 1);
  const providerId = providerByAlias.get(providerAlias);
  const reasoningEfforts = providerId
    ? (getThinkingLevels(providerId, upstreamModelId) || [])
    : [];

  return { modelId: memberId, reasoningEfforts };
}

function comboReasoningCapabilities(combo, providerByAlias) {
  const comboReasoningMembers = Array.isArray(combo?.models)
    ? combo.models.map((modelId) => comboReasoningMember(modelId, providerByAlias))
    : [];
  const [firstMember] = comboReasoningMembers;
  // Combo fallbacks are expected to be semantically equivalent. Treat a divergent
  // capability list as a configuration error and fail closed instead of advertising a
  // partial overlap that would hide it from the administrator.
  const reasoningEfforts = firstMember && comboReasoningMembers.every((member) =>
    member.reasoningEfforts.length === firstMember.reasoningEfforts.length &&
    member.reasoningEfforts.every((effort, index) => effort === firstMember.reasoningEfforts[index]),
  )
    ? firstMember.reasoningEfforts
    : [];

  return { comboReasoningMembers, reasoningEfforts };
}

function makeModelEntry({ modelId, providerId, publicAlias, staticModelById }) {
  const staticModel = staticModelById.get(modelId);
  const caps = getCapabilitiesForModel(providerId, modelId);
  const reasoningEfforts = getThinkingLevels(providerId, modelId) || [];
  return {
    id: modelId,
    publicId: `${publicAlias}/${modelId}`,
    name: staticModel?.name || modelId,
    type: staticModel?.type || DEFAULT_MODEL_TYPE,
    enabled: true,
    caps: {
      reasoning: caps.reasoning,
      thinkingFormat: caps.thinkingFormat,
      thinkingCanDisable: caps.thinkingCanDisable,
      thinkingOptions: resolveThinkingOptions(caps.thinkingFormat),
      // Exact public effort values. Consumers must prefer this over the UI-oriented
      // thinkingOptions list, which intentionally contains provider-format options.
      reasoningEfforts,
    },
  };
}

async function buildEffectiveModels({ connection, alias, providerId, staticModelById, passthroughModels, disabledByAlias, customModels, modelAliases }) {
  const outputAlias = normalizeOutputAlias(connection, alias);
  const scopeAliases = [outputAlias, alias, connection.provider];
  const enabledModels = connection?.providerSpecificData?.enabledModels;

  let rawModelIds;
  if (Array.isArray(enabledModels) && enabledModels.length > 0) {
    // Explicit whitelist configured — use exactly those models.
    rawModelIds = enabledModels;
  } else if (passthroughModels) {
    // Pass-through provider (e.g. OpenRouter): models are chosen via aliases,
    // not via a static catalog. Don't auto-include the static catalog or call
    // the live API — let aliasModelIds below carry the intended set.
    rawModelIds = [];
  } else if (staticModelById.size === 0) {
    // No static catalog for this provider (e.g. openai-compatible-* nodes).
    // Fall back to live provider API to discover what's actually available.
    try {
      const liveResult = await fetchProviderModelsForConnection(connection);
      if (!liveResult.error && Array.isArray(liveResult.models) && liveResult.models.length > 0) {
        rawModelIds = liveResult.models
          .map((m) => (typeof m === "string" ? m : m?.id || m?.name || m?.model || null))
          .filter(Boolean);
      } else {
        rawModelIds = [];
      }
    } catch {
      rawModelIds = [];
    }
  } else {
    // Standard provider with a static model catalog — use it as the default set.
    rawModelIds = Array.from(staticModelById.keys());
  }

  const normalizedStaticIds = rawModelIds
    .map((id) => normalizeModelId(id, scopeAliases))
    .filter(Boolean);

  const customModelIds = customModels
    .filter(
      (m) =>
        m?.providerAlias &&
        m?.id &&
        (!m.type || m.type === DEFAULT_MODEL_TYPE) &&
        scopeAliases.includes(m.providerAlias),
    )
    .map((m) => normalizeModelId(String(m.id), scopeAliases))
    .filter(Boolean);

  const aliasModelIds = Object.values(modelAliases)
    .filter(
      (fullModel) =>
        typeof fullModel === "string" &&
        fullModel.includes("/") &&
        scopeAliases.some((c) => fullModel.startsWith(`${c}/`)),
    )
    .map((fullModel) => normalizeModelId(fullModel, scopeAliases))
    .filter(Boolean);

  const mergedIds = Array.from(new Set([...normalizedStaticIds, ...customModelIds, ...aliasModelIds]));

  return mergedIds
    .filter((modelId) => (disabledByAlias ? !isDisabled(disabledByAlias, scopeAliases, modelId) : true))
    .map((modelId) => makeModelEntry({ modelId, providerId, publicAlias: outputAlias, staticModelById }));
}

export async function GET() {
  try {
    const [connections, disabledByAlias, customModels, modelAliases] = await Promise.all([
      getProviderConnections(),
      getDisabledModels().catch(() => null),
      getCustomModels().catch(() => []),
      getModelAliases().catch(() => ({})),
    ]);

    const activeConnections = connections.filter((c) => c.isActive !== false);
    const providerByAlias = new Map();
    for (const connection of activeConnections) {
      for (const alias of connectionAliases(connection)) {
        providerByAlias.set(alias, connection.provider);
      }
    }

    const result = await Promise.all(
      activeConnections.map(async (connection) => {
        const providerId = connection.provider;
        const alias =
          ID_TO_ALIAS[providerId] ||
          getProviderAlias(providerId) ||
          PROVIDER_ID_TO_ALIAS[providerId] ||
          providerId;

        const staticModels = getModelsByProviderId(providerId);
        const staticModelById = new Map(
          staticModels.map((m) => [m.id, { name: m.name || m.id, type: m.type || DEFAULT_MODEL_TYPE }]),
        );

        const providerInfo = AI_PROVIDERS[providerId];
        const models = await buildEffectiveModels({
          connection,
          alias,
          providerId,
          staticModelById,
          passthroughModels: !!providerInfo?.passthroughModels,
          disabledByAlias,
          customModels,
          modelAliases,
        });

        return {
          id: connection.id,
          provider: providerId,
          authType: connection.authType,
          name: connection.name ?? null,
          isActive: true,
          testStatus: connection.testStatus ?? null,
          models,
        };
      }),
    );

    // Add combos as a special "combo" provider connection
    const combos = await getCombos().catch(() => []);
    if (combos.length > 0) {
      const comboModels = combos.map((combo) => {
        const { comboReasoningMembers, reasoningEfforts } = comboReasoningCapabilities(combo, providerByAlias);
        return {
          id: combo.name,
          publicId: combo.name,
          name: combo.name,
          type: "combo",
          enabled: true,
          caps: {
            reasoning: reasoningEfforts.length > 0,
            thinkingCanDisable: true,
            thinkingOptions: [],
            reasoningEfforts,
            comboReasoningMembers,
          },
        };
      });

      result.push({
        id: "__combos__",
        provider: "combo",
        authType: "none",
        name: "Combos",
        isActive: true,
        testStatus: null,
        models: comboModels,
      });
    }

    return NextResponse.json({ connections: result });
  } catch (error) {
    console.log("[Integrations] Failed to fetch providers with models:", error);
    return NextResponse.json({ error: "Failed to fetch providers with models" }, { status: 500 });
  }
}
