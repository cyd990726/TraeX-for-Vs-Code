import type { Model } from './protocol/v2/Model';
import type { ReasoningEffort } from './protocol/ReasoningEffort';
import type { ReasoningEffortOption } from './protocol/v2/ReasoningEffortOption';
export type ModelMode = { id: string; name: string; contextWindow?: number; reasoning: ReasoningEffortOption[]; defaultReasoning: ReasoningEffort };
export function modelModes(model: Model): ModelMode[] {
  const variants = model.businessMetadata?.variants;
  if (!variants) return [];
  return (['standard', 'max'] as const).flatMap(kind => {
    const id = variants[`${kind}_key`];
    if (!id) return [];
    const levels = variants[`${kind}_supported_reasoning_levels`];
    const context = variants[`${kind}_context_window`];
    return [{ id, name: kind === 'standard' ? 'Standard' : 'Max', contextWindow: context == null ? undefined : Number(context), reasoning: levels ? levels.map(level => ({reasoningEffort: level.effort, description: level.description})) : model.supportedReasoningEfforts ?? [], defaultReasoning: variants[`${kind}_default_reasoning_level`] ?? model.defaultReasoningEffort }];
  });
}
export function resolveMode(modes: ModelMode[], id?: string): ModelMode | undefined {
  return modes.find(mode => mode.id === id || mode.name.toLowerCase() === id?.toLowerCase()) ?? modes[0];
}
