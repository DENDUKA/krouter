import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ connections: [], combos: [], levels: {} }));

vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnections: vi.fn(async () => state.connections),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getCombos: vi.fn(async () => state.combos),
}));
vi.mock("../../src/lib/disabledModelsDb.js", () => ({ getDisabledModels: vi.fn(async () => null) }));
vi.mock("../../src/shared/constants/models.js", () => ({
  PROVIDER_ID_TO_ALIAS: {}, getModelsByProviderId: vi.fn(() => []),
}));
vi.mock("../../src/shared/constants/providers.js", () => ({
  ID_TO_ALIAS: {}, getProviderAlias: vi.fn((providerId) => providerId), AI_PROVIDERS: {},
  THINKING_CONFIG: { effort: { options: [] }, extended: { options: [] } },
}));
vi.mock("../../src/app/api/providers/[id]/models/route.js", () => ({
  fetchProviderModelsForConnection: vi.fn(async () => ({ models: [] })),
}));
vi.mock("../../open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel: vi.fn(() => ({})) }));
vi.mock("../../open-sse/providers/thinkingLevels.js", () => ({
  getThinkingLevels: vi.fn((providerId, modelId) => state.levels[`${providerId}/${modelId}`] ?? null),
}));

import { GET } from "../../src/app/api/integrations/providers/with-models/route.js";

function comboModel(body) {
  return body.connections.find((connection) => connection.provider === "combo").models[0];
}

describe("GET /api/integrations/providers/with-models — combo reasoning", () => {
  beforeEach(() => {
    state.connections.length = 0;
    state.combos.length = 0;
    state.levels = {};
    vi.clearAllMocks();
  });

  function configureCombo(levels) {
    state.connections.push(
      { id: "a", provider: "alpha", isActive: true, providerSpecificData: {} },
      { id: "b", provider: "beta", isActive: true, providerSpecificData: {} },
    );
    state.combos.push({ name: "public-combo", models: ["alpha/model", "beta/model"] });
    state.levels = levels;
  }

  it("publishes canonical levels when every fallback has the same levels", async () => {
    configureCombo({ "alpha/model": ["low", "medium"], "beta/model": ["low", "medium"] });

    const body = await (await GET()).json();
    const combo = comboModel(body);

    expect(combo.caps.reasoningEfforts).toEqual(["low", "medium"]);
    expect(combo.caps.comboReasoningMembers).toEqual([
      { modelId: "alpha/model", reasoningEfforts: ["low", "medium"] },
      { modelId: "beta/model", reasoningEfforts: ["low", "medium"] },
    ]);
  });

  it("fails closed when a fallback has different or no reasoning levels", async () => {
    configureCombo({ "alpha/model": ["low", "medium"], "beta/model": ["medium"] });
    const body = await (await GET()).json();
    expect(comboModel(body).caps.reasoningEfforts).toEqual([]);

    state.levels = { "alpha/model": ["low", "medium"] };
    const noReasoningBody = await (await GET()).json();
    expect(comboModel(noReasoningBody).caps.reasoningEfforts).toEqual([]);
  });
});
