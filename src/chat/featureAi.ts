import type { AgentId, ChatModel } from './chatProtocol';

export type AiFeature = 'commitMessage' | 'branchName' | 'chatTitle';
export type FeatureEffort = 'minimum' | 'medium' | 'maximum';
export interface FeatureAiChoice {
	readonly agent: 'auto' | AgentId;
	readonly effort: FeatureEffort;
}
export type FeatureAiSettings = Readonly<Record<AiFeature, FeatureAiChoice>>;
export const featureAiKey = 'aiBrowser.chat.featureAi';
export const aiFeatures: readonly AiFeature[] = ['commitMessage', 'branchName', 'chatTitle'];

/** Validate stored data and webview input before using it to start a model. */
export function readFeatureAiSettings(value: unknown): FeatureAiSettings {
	const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	return Object.fromEntries(aiFeatures.map(feature => {
		const raw = record[feature];
		const choice = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
		return [feature, {
			agent: choice.agent === 'claude' || choice.agent === 'codex' ? choice.agent : 'auto',
			effort: choice.effort === 'medium' || choice.effort === 'maximum' ? choice.effort : 'minimum',
		}];
	})) as unknown as FeatureAiSettings;
}

/** Map the three UI levels to the actual levels supported by a model. */
export function featureEffort(model: ChatModel, level: FeatureEffort): string | undefined {
	const levels = model.efforts;
	if (level === 'maximum') { return levels[levels.length - 1]; }
	if (level === 'medium') { return levels.find(e => e === 'medium') ?? levels[Math.floor((levels.length - 1) / 2)]; }
	return levels[0];
}
