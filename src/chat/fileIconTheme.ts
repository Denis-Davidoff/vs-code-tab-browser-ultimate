import * as vscode from 'vscode';
import type { FileThemeIcon, WorkdirGitStatus } from './chatProtocol';
import type { FileIconTable, TableIcon } from './fileIconTable';

interface Associations {
 file?: string;
 folder?: string;
 folderNames?: Record<string, string>;
 fileNames?: Record<string, string>;
 fileExtensions?: Record<string, string>;
 languageIds?: Record<string, string>;
}
interface Theme extends Associations {
 light?: Associations;
 highContrast?: Associations;
 iconDefinitions?: Record<string, { iconPath?: string; fontCharacter?: string; fontId?: string; fontColor?: string; fontSize?: string }>;
 fonts?: { id: string; size?: string; src: { path: string; format: string }[] }[];
}

/** JSON with comments and trailing commas, as supported by VS Code theme files. */
export function parseIconTheme(text: string): Theme {
 const plain = text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, token => token.startsWith('"') ? token : '');
 return JSON.parse(plain.replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : ''));
}

/** Theme glyphs use CSS string escapes; textContent needs the decoded characters. */
export function decodeFontCharacter(value: string): string {
 return value.replace(/\\(?:([\da-fA-F]{1,6})(?:\r\n|[\t\n\f\r ])?|\r\n|[\n\f\r]|([^\n\f\r]))/g, (_escape, hex: string | undefined, literal: string | undefined) => {
  if (!hex) { return literal ?? ''; }
  const point = parseInt(hex, 16);
  return String.fromCodePoint(point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? 0xfffd : point);
 });
}

export function fileIconId(theme: Theme, path: string, language: string | undefined, variant?: 'light' | 'highContrast'): string | undefined {
 const base = path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
 const specific = variant ? theme[variant] : undefined;
 const lookup = (key: 'fileNames' | 'fileExtensions' | 'languageIds', value: string) => specific?.[key]?.[value] ?? theme[key]?.[value];
 const named = lookup('fileNames', base);
 if (named) { return named; }
 for (let dot = base.indexOf('.'); dot >= 0; dot = base.indexOf('.', dot + 1)) {
  const matched = lookup('fileExtensions', base.slice(dot + 1));
  if (matched) { return matched; }
 }
 return (language && lookup('languageIds', language)) || specific?.file || theme.file;
}

type Definition = NonNullable<Theme['iconDefinitions']>[string];
interface LoadedTheme {
 readonly theme: Theme;
 readonly variant?: 'light' | 'highContrast';
 readonly icon: (definition: Definition | undefined) => FileThemeIcon | undefined;
}

/**
 * The theme `workbench.iconTheme` selects, read again on every call (a theme
 * file can be generated), with the webview allowed to load from its extension.
 * `undefined` with no theme selected or the extension gone.
 */
function selectedIconTheme() {
 const selected = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
 const contributions = vscode.extensions.all.flatMap(extension =>
  (extension.packageJSON.contributes?.iconThemes ?? []).map((theme: { id: string; path: string }) => ({ extension, theme })));
 return contributions.find(entry => entry.theme.id === selected);
}

/**
 * The folders the chat view may load from: `media/` and the selected icon
 * theme's extension. Set when the view is created as well as on every theme
 * read, because a change of `localResourceRoots` makes VS Code send the page
 * again — the view's script starts over and every message posted until its
 * next `ready` is lost. Created with the same roots, the reads change nothing.
 */
export function chatResourceRoots(media: vscode.Uri): vscode.Uri[] {
 const chosen = selectedIconTheme();
 return [media, ...(chosen ? [chosen.extension.extensionUri] : [])];
}

async function loadSelectedTheme(webview: vscode.Webview, media: vscode.Uri): Promise<LoadedTheme | undefined> {
 const chosen = selectedIconTheme();
 // Remove old resource roots when icons are disabled or the selected extension
 // disappears. An unchanged list is not assigned: VS Code skips equal options,
 // but this keeps the reload out of reach of a host that does not.
 const roots = chatResourceRoots(media);
 const current = webview.options.localResourceRoots ?? [];
 if (roots.length !== current.length || roots.some((root, i) => root.toString() !== current[i].toString())) {
  webview.options = { ...webview.options, localResourceRoots: roots };
 }
 if (!chosen) { return undefined; }
 const uri = vscode.Uri.joinPath(chosen.extension.extensionUri, chosen.theme.path);
 const directory = vscode.Uri.joinPath(uri, '..');
 const theme = parseIconTheme(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
 const kind = vscode.window.activeColorTheme.kind;
 const variant = kind === vscode.ColorThemeKind.Light ? 'light'
  : kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight ? 'highContrast' : undefined;
 const resource = (relative: string) => webview.asWebviewUri(vscode.Uri.joinPath(directory, relative)).toString();
 const icon = (definition: Definition | undefined): FileThemeIcon | undefined => {
  if (definition?.iconPath) { return { image: resource(definition.iconPath) }; }
  if (definition?.fontCharacter) {
   const font = theme.fonts?.find(f => f.id === definition.fontId) ?? theme.fonts?.[0];
   if (font?.src[0]) { return { character: decodeFontCharacter(definition.fontCharacter), font: resource(font.src[0].path), color: definition.fontColor, size: definition.fontSize ?? font.size }; }
  }
  return undefined;
 };
 return { theme, variant, icon };
}

interface LanguageContribution { id: string; filenames?: string[]; extensions?: string[] }
const languageContributions = () =>
 vscode.extensions.all.flatMap(extension => extension.packageJSON.contributes?.languages ?? []) as LanguageContribution[];

const lowerKeys = (record: Record<string, string> | undefined): Record<string, string> =>
 Object.fromEntries(Object.entries(record ?? {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k.toLowerCase(), v]));

/**
 * The selected theme as a table the chat view looks names up in itself
 * (`resolveFileIcon`): a reply can name any file, so the icons cannot be
 * resolved here path by path the way the Git list's are. Languages come from
 * the extensions' contributions, plus `files.associations` entries that are a
 * plain name or `*.ext`; glob patterns are left out.
 */
export async function loadFileIconTable(webview: vscode.Webview, media: vscode.Uri): Promise<FileIconTable | undefined> {
 const loaded = await loadSelectedTheme(webview, media);
 if (!loaded) { return undefined; }
 const { theme, variant } = loaded;
 const specific = variant ? theme[variant] : undefined;
 const merged = (key: 'fileNames' | 'fileExtensions' | 'folderNames' | 'languageIds') => ({ ...lowerKeys(theme[key]), ...lowerKeys(specific?.[key]) });
 const languageByName: Record<string, string> = {};
 const languageByExtension: Record<string, string> = {};
 for (const language of languageContributions()) {
  for (const name of language.filenames ?? []) { languageByName[name.toLowerCase()] ??= language.id; }
  for (const extension of language.extensions ?? []) { languageByExtension[extension.toLowerCase().replace(/^\./, '')] ??= language.id; }
 }
 const associations = vscode.workspace.getConfiguration('files').get<Record<string, string>>('associations', {});
 for (const [pattern, language] of Object.entries(associations)) {
  if (typeof language !== 'string') { continue; }
  const extension = /^\*\.([^*?[\]{}/\\]+)$/.exec(pattern)?.[1];
  if (extension) { languageByExtension[extension.toLowerCase()] = language; }
  else if (!/[*?[\]{}/\\]/.test(pattern)) { languageByName[pattern.toLowerCase()] = language; }
 }
 const maps = { fileNames: merged('fileNames'), fileExtensions: merged('fileExtensions'), folderNames: merged('folderNames'), languageIds: merged('languageIds') };
 const file = specific?.file ?? theme.file;
 const folder = specific?.folder ?? theme.folder;
 // Only what this colour theme's associations reach: the light and
 // high-contrast definitions of the other kinds are half of a theme like Seti.
 const used = new Set<string>([...Object.values(maps).flatMap(map => Object.values(map)), ...(file ? [file] : []), ...(folder ? [folder] : [])]);
 const fonts: string[] = [];
 const icons: Record<string, TableIcon> = {};
 for (const id of used) {
  const icon = loaded.icon(theme.iconDefinitions?.[id]);
  if (!icon) { continue; }
  let font: number | undefined;
  if (icon.font) {
   font = fonts.indexOf(icon.font);
   if (font < 0) { font = fonts.push(icon.font) - 1; }
  }
  icons[id] = { image: icon.image, character: icon.character, font, color: icon.color, size: icon.size };
 }
 return { fonts, icons, file, folder, ...maps, languageByName, languageByExtension };
}

/** Each refresh reads the selected theme again, including generated theme files. */
export async function themedGitFiles(status: WorkdirGitStatus, webview: vscode.Webview, media: vscode.Uri, folder?: vscode.Uri): Promise<WorkdirGitStatus> {
 try {
  const loaded = await loadSelectedTheme(webview, media);
  if (!loaded) { return status; }
  const { theme, variant } = loaded;
  const languages = languageContributions();
  const decorate = (file: WorkdirGitStatus['staged'][number]) => {
   const uri = folder ? vscode.Uri.joinPath(folder, file.path) : undefined;
   const openLanguage = uri ? vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString())?.languageId : undefined;
   let configuredLanguage: string | undefined;
   if (uri && (!openLanguage || openLanguage === 'plaintext')) {
    const associations = vscode.workspace.getConfiguration('files', uri).get<Record<string, string>>('associations', {});
    // Longest pattern wins; for equal lengths, the last configured association wins.
    const patterns = Object.entries(associations).reverse().sort(([a], [b]) => b.length - a.length);
    // Pattern-only selectors inspect uri/languageId, so deleted files need no document opened.
    const target = { uri: uri.with({ path: uri.path.toLowerCase() }), languageId: '' } as vscode.TextDocument;
    configuredLanguage = patterns.find(([pattern, language]) => typeof language === 'string' && vscode.languages.match({
     pattern: pattern.includes('/') ? pattern.toLowerCase() : `**/${pattern.toLowerCase()}`,
    }, target) > 0)?.[1];
   }
   const basename = file.path.split('/').pop()!.toLowerCase();
   const language = languages.find(l => l.filenames?.some(n => n.toLowerCase() === basename))
    ?? languages.filter(l => l.extensions?.some(ext => basename.endsWith(ext.toLowerCase())))
     .sort((a, b) => Math.max(...b.extensions!.filter(ext => basename.endsWith(ext.toLowerCase())).map(ext => ext.length)) - Math.max(...a.extensions!.filter(ext => basename.endsWith(ext.toLowerCase())).map(ext => ext.length)))[0];
   const id = fileIconId(theme, file.path, openLanguage && openLanguage !== 'plaintext' ? openLanguage : configuredLanguage ?? language?.id, variant);
   const definition = id ? theme.iconDefinitions?.[id] : undefined;
   const icon = loaded.icon(definition);
   return { ...file, ...(icon ? { icon } : {}) };
  };
  return { ...status, staged: status.staged.map(decorate), unstaged: status.unstaged.map(decorate) };
 } catch { return status; } // An unavailable theme must not hide Git changes.
}
