import type { LlmRequest } from "cursor-byok:channel";
import type { ModelDefinition, ModelSnapshot, ModelSupport } from "cursor-byok:model";
import { unary } from "./connect.ts";
import { accountData } from "./resources.ts";

/**
 * Devin lists every tier of a model as its own model (`claude-opus-5-5-high-fast`, ...), grouped by
 * `modelInfo.modelFamilyUid`. Keybridge publishes one model per family and keeps the tiers here as
 * members; each call picks the member matching Cursor's Effort, Fast and Context settings.
 */
type Member = {
  id: string;
  /** Normalized effort level, or null when the family has no effort axis. */
  effort: string | null;
  fast: boolean;
  contextWindow: number | null;
};

type FamilyData = { members: Member[]; defaultId: string };

type DimensionValue = { order?: number; name?: string };
type CatalogModel = Record<string, any>;

/** Effort levels in ascending order; Devin's stepper names normalize onto these. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const EFFORT_KEYS = new Set(["Effort", "Reasoning Effort"]);

function dimension(model: CatalogModel, key: string): DimensionValue | undefined {
  const entries = model.modelFamilyMetadata?.entries;
  if (!Array.isArray(entries)) return undefined;
  const found = entries.find((entry) => entry?.key === key);
  return found ? (found.value ?? {}) : undefined;
}

/** Option dimensions are toggles: a non-zero order means on. */
function enabled(value: DimensionValue | undefined): boolean {
  return !!value?.order;
}

export function normalizeEffort(name: string | undefined): string | null {
  const value = (name ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (!value) return null;
  if (value === "nothinking" || value === "off") return "none";
  if (value === "extrahigh") return "xhigh";
  return value;
}

function memberEffort(model: CatalogModel): string | null {
  // A Thinking toggle that is off is the reasoning-off level of the family.
  const thinking = dimension(model, "Thinking");
  if (thinking && !enabled(thinking)) return "none";
  const entries = model.modelFamilyMetadata?.entries;
  const stepper = Array.isArray(entries)
    ? entries.find((entry) => EFFORT_KEYS.has(entry?.key))?.value
    : undefined;
  return stepper ? normalizeEffort(stepper.name) : null;
}

function rank(effort: string): number {
  const index = EFFORT_ORDER.indexOf(effort);
  return index < 0 ? EFFORT_ORDER.length : index;
}

function contextWindowOf(model: CatalogModel): number | null {
  return Number(model.maxTokens ?? model.modelInfo?.maxTokens) || null;
}

function familyDefinition(familyId: string, models: CatalogModel[]): ModelDefinition {
  const members: Member[] = models.map((model) => ({
    id: model.modelUid,
    effort: memberEffort(model),
    fast: enabled(dimension(model, "Fast Mode")),
    contextWindow: contextWindowOf(model),
  }));
  // Devin flags one default per family; without it prefer the standard-speed High tier.
  const flagged = models.findIndex((model) => model.modelFamilyMetadata?.isDefaultModelInFamily);
  const defaultMember = members[flagged] ??
    members.find((member) => member.effort === "high" && !member.fast) ??
    members.find((member) => !member.fast) ?? members[0];
  const primary = models[members.indexOf(defaultMember)];
  const efforts = [
    ...new Set(members.flatMap((member) => member.effort ? [member.effort] : [])),
  ].sort((left, right) => rank(left) - rank(right));
  const fast = members.some((member) => member.fast) && members.some((member) => !member.fast);
  const windows = members.flatMap((member) => member.contextWindow ? [member.contextWindow] : []);
  const outputs = models.map((model) => Number(model.modelInfo?.maxOutputTokens) || 0);
  const maxOutputTokens = Math.max(...outputs) || undefined;
  const label = primary.modelFamilyMetadata?.modelFamilyLabel ?? primary.label ?? familyId;
  const options = {
    ...(efforts.length > 1
      ? {
        efforts,
        ...(defaultMember.effort ? { defaultEffort: defaultMember.effort } : {}),
      }
      : {}),
    ...(fast ? { fast } : {}),
  };
  return {
    id: familyId,
    displayName: label,
    description: `Devin - ${label}`,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(windows.length ? { contextWindow: Math.max(...windows) } : {}),
    capabilities: {
      images: models.some((model) =>
        model.supportsImages === true || model.modelInfo?.modelFeatures?.supportsImages === true
      ),
    },
    ...(Object.keys(options).length ? { options } : {}),
    privateData: { members, defaultId: defaultMember.id } satisfies FamilyData,
  };
}

export function parseModels(body: Record<string, any>): ModelDefinition[] {
  if (!Array.isArray(body.clientModelConfigs)) {
    throw new Error("Devin model discovery returned no model catalog");
  }
  const families = new Map<string, CatalogModel[]>();
  const seen = new Set<string>();
  for (const model of body.clientModelConfigs as CatalogModel[]) {
    const id = model.modelUid;
    if (typeof id !== "string" || !id || seen.has(id) || model.isModelRouter) continue;
    seen.add(id);
    const family = model.modelInfo?.modelFamilyUid;
    const key = typeof family === "string" && family ? family : id;
    families.set(key, [...(families.get(key) ?? []), model]);
  }
  return [...families].map(([familyId, models]) => familyDefinition(familyId, models));
}

/** Picks the family member that matches the requested Effort, then Fast, then Context. */
export function requestModelId(
  model: ModelSnapshot,
  request: Pick<LlmRequest, "reasoning" | "latency" | "contextWindow">,
): string {
  const data = model.privateData as Partial<FamilyData> | null | undefined;
  const members = Array.isArray(data?.members) ? data.members : [];
  if (members.length === 0) return model.id;
  const fallback = members.find((member) => member.id === data?.defaultId) ?? members[0];

  const efforts = [...new Set(members.flatMap((member) => member.effort ? [member.effort] : []))];
  const requested = request.reasoning.effort ??
    (request.reasoning.enabled ? null : "none");
  let effort = fallback.effort;
  if (requested && efforts.includes(requested)) {
    effort = requested;
  } else if (requested && requested !== "none" && efforts.length) {
    // Nearest available level; ties go to the higher one.
    effort = efforts.reduce((best, candidate) => {
      const distance = Math.abs(rank(candidate) - rank(requested));
      const bestDistance = Math.abs(rank(best) - rank(requested));
      return distance < bestDistance || (distance === bestDistance && rank(candidate) > rank(best))
        ? candidate
        : best;
    });
  }

  let candidates = members.filter((member) => member.effort === effort);
  const fast = request.latency === "fast";
  const sameSpeed = candidates.filter((member) => member.fast === fast);
  if (sameSpeed.length) candidates = sameSpeed;

  const wanted = request.contextWindow ?? 0;
  const window = (member: Member) => member.contextWindow ?? 0;
  const fitting = candidates.filter((member) => window(member) >= wanted);
  const chosen = fitting.length
    ? fitting.reduce((best, member) => window(member) < window(best) ? member : best)
    : candidates.reduce((best, member) => window(member) > window(best) ? member : best);
  return chosen.id;
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
