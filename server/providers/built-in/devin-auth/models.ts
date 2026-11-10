import type { ModelDefinition, ModelSnapshot, ModelSupport } from "cursor-byok:model";
import { unary } from "./connect.ts";
import { accountData } from "./resources.ts";

const FAST_MODE = "Fast Mode";

type FamilyEntry = { key?: string; value?: { order?: number; name?: string } };
type CatalogModel = {
  modelUid?: unknown;
  modelInfo?: { modelFamilyUid?: unknown };
  modelFamilyMetadata?: { entries?: unknown };
};

function familyEntries(model: CatalogModel): FamilyEntry[] {
  const entries = model.modelFamilyMetadata?.entries;
  return Array.isArray(entries) ? entries : [];
}

function isFastMode(model: CatalogModel): boolean {
  return familyEntries(model).some((entry) => entry.key === FAST_MODE && !!entry.value?.order);
}

function fastModeSiblingKey(model: CatalogModel): string | null {
  const family = model.modelInfo?.modelFamilyUid;
  const entries = familyEntries(model);
  if (typeof family !== "string" || !entries.some((entry) => entry.key === FAST_MODE)) {
    return null;
  }
  const settings = entries
    .filter((entry) => entry.key !== FAST_MODE)
    .map((entry) => [entry.key, entry.value?.order ?? 0, entry.value?.name ?? ""]);
  return JSON.stringify([family, settings]);
}

export function parseModels(body: Record<string, any>): ModelDefinition[] {
  if (!Array.isArray(body.clientModelConfigs)) {
    throw new Error("Devin model discovery returned no model catalog");
  }
  const fastModels = new Map<string, string>();
  for (const model of body.clientModelConfigs as CatalogModel[]) {
    const key = fastModeSiblingKey(model);
    if (key && isFastMode(model) && typeof model.modelUid === "string") {
      fastModels.set(key, model.modelUid);
    }
  }
  const seen = new Set<string>();
  return body.clientModelConfigs.flatMap((model: Record<string, any>) => {
    const id = model.modelUid;
    if (typeof id !== "string" || !id || seen.has(id) || model.isModelRouter) {
      return [];
    }
    seen.add(id);
    const info = model.modelInfo ?? {};
    const key = fastModeSiblingKey(model);
    const fastModelId = key && !isFastMode(model) ? fastModels.get(key) : undefined;
    return [{
      id,
      displayName: model.label || id,
      description: `Devin - ${
        model.modelFamilyMetadata?.modelFamilyLabel ?? id
      }`,
      maxOutputTokens: Number(info.maxOutputTokens) || undefined,
      capabilities: {
        images: model.supportsImages === true ||
          info.modelFeatures?.supportsImages === true,
      },
      privateData: {
        contextWindow: Number(model.maxTokens ?? info.maxTokens) || null,
        provider: model.provider ?? null,
        ...(fastModelId ? { fastModelId } : {}),
      },
    }];
  });
}

export function requestModelId(model: ModelSnapshot, latency: "fast" | "standard"): string {
  const fastModelId = (model.privateData as Record<string, unknown> | undefined)?.fastModelId;
  return latency === "fast" && typeof fastModelId === "string" ? fastModelId : model.id;
}

export const devinModels: ModelSupport = {
  async list({ resource }, context) {
    if (!resource) {
      throw new Error("Import a Devin account before syncing models");
    }
    return parseModels(
      await unary("GetCliModelConfigs", accountData(resource).token, context),
    );
  },
};
