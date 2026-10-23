import type { ViewToHost } from './chatProtocol';
/** Change only for incompatible common-envelope changes; evolve individual features below. */
export const chromeChatProtocolVersion = 2;
export const chromeChatProtocolHeader = 'X-AI-Browser-Protocol';
export const chromeChatVersionHeader = 'X-AI-Browser-Version';

function protocol(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function version(value: unknown): string {
  return typeof value === 'string' && /^[0-9]+(?:\.[0-9]+){1,3}(?:-[a-zA-Z0-9.-]+)?$/.test(value) && value.length <= 50 ? value : 'unknown';
}

/** Release versions may differ; the wire protocol decides whether they work together. */
export function chromeChatCompatibilityError(editorProtocol: unknown, chromeProtocol: unknown, editorVersion?: unknown, chromeVersion?: unknown): string | undefined {
  const editor = protocol(editorProtocol), chrome = protocol(chromeProtocol);
  if (editor > 0 && editor === chrome) { return undefined; }
  const update = editor === chrome ? 'both AI Browser extensions'
    : editor < chrome ? 'the AI Browser extension for VS Code' : 'the AI Browser extension for Chrome';
  return `Incompatible AI Browser versions: VS Code ${version(editorVersion)}, Chrome ${version(chromeVersion)}. Update ${update} to the latest version, then reconnect.`;
}

/** Feature versions describe wire contracts, independently of release numbers. */
export const chromeChatCapabilities = {
  usage: [1], context: [1], skills: [1], workdir: [1], git: [1], github: [1],
  chat: [1], elements: [1], screenshots: [1], files: [1], video: [1],
  page: [1], sharedPage: [1], annotations: [1],
} as const;
export type ChromeChatFeature = keyof typeof chromeChatCapabilities;
export type ChromeChatCapabilities = Readonly<Record<string, readonly number[]>>;
export const chromeChatCapabilitiesHeader = 'X-AI-Browser-Capabilities';

// Frozen historical contracts: do not expand this when adding newer capabilities.
const transportV2Baseline: ChromeChatCapabilities = {
  chat: [1], elements: [1], screenshots: [1], files: [1], video: [1],
  page: [1], sharedPage: [1], annotations: [1],
};

/** Missing maps from transport v2 peers mean the original v1 feature contracts. */
export function readChromeChatCapabilities(value: unknown, transport: unknown): ChromeChatCapabilities {
  if (value === undefined) { return transport === 2 ? transportV2Baseline : {}; }
  if (typeof value === 'string') {
    if (value.length > 4096) { return {}; }
    try { value = JSON.parse(value); } catch { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return {}; }
  const entries = Object.entries(value);
  if (entries.length > 64) { return {}; }
  const result: Record<string, number[]> = Object.create(null);
  for (const [name, versions] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(name) || !Array.isArray(versions) || versions.length > 16
      || !versions.every(v => Number.isSafeInteger(v) && v > 0)) { return {}; }
    result[name] = [...new Set(versions)];
  }
  return result;
}

export function negotiateChromeChatCapabilities(peer: unknown, transport: unknown,
  local: ChromeChatCapabilities = chromeChatCapabilities): Partial<Record<ChromeChatFeature, number>> {
  const remote = readChromeChatCapabilities(peer, transport);
  const result: Partial<Record<ChromeChatFeature, number>> = {};
  for (const name of Object.keys(chromeChatCapabilities) as ChromeChatFeature[]) {
    const common = (local[name] ?? []).filter(v => remote[name]?.includes(v));
    if (common.length) { result[name] = Math.max(...common); }
  }
  return result;
}

export function chromeChatFeatureError(feature: ChromeChatFeature): string {
  return `The ${feature} feature is incompatible or unavailable. Update the AI Browser extensions to the latest version to use it. Other compatible features remain available.`;
}

export function chromeChatAttachmentFeature(kind: string | undefined): ChromeChatFeature {
  switch (kind) {
    case 'screenshot': return 'screenshots';
    case 'file': return 'files';
    case 'pointAnnotation': case 'annotation': return 'annotations';
    case 'video': case 'page': case 'sharedPage': return kind;
    default: return 'elements';
  }
}

/** Kept separate so older peers do not implicitly gain newly added actions. */
export const chromeChatFooterCommands = {
  usage: ['usage', 'dismissUsageAlert'],
  context: ['compact'],
  skills: ['listCommands', 'runToolbarSkill', 'stopToolbarSkill', 'toolbarApprove', 'saveToolbarSkill', 'deleteToolbarSkill', 'moveToolbarSkill', 'placeToolbarSkill'],
  workdir: ['listWorkdir', 'setWorkdir', 'chooseWorkdir', 'attachPath'],
  git: ['refreshWorkdirGit', 'gitCommit', 'gitIndexAction', 'openGitDiff', 'fixGitCommit', 'dismissGitCommit', 'gitBranchName', 'gitBranchAction', 'gitRemoteAction', 'restoreBranchStash'],
  github: ['openRepo', 'repoAction', 'trustWorkdir', 'removeRepoFolder'],
} as const;
export function chromeChatCommandFeature(message: Pick<ViewToHost, 'type'>): ChromeChatFeature {
  for (const [feature, commands] of Object.entries(chromeChatFooterCommands)) {
    if ((commands as readonly string[]).includes(message.type)) { return feature as ChromeChatFeature; }
  }
  return 'chat';
}
