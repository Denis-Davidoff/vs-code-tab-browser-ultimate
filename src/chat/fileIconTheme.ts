import * as vscode from 'vscode';
import type { FileThemeIcon, WorkdirGitStatus } from './chatProtocol';

interface Associations {
 file?: string;
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

/** Each refresh reads the selected theme again, including generated theme files. */
export async function themedGitFiles(status: WorkdirGitStatus, webview: vscode.Webview, media: vscode.Uri, folder?: vscode.Uri): Promise<WorkdirGitStatus> {
 try {
  const selected = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
  const contributions = vscode.extensions.all.flatMap(extension =>
   (extension.packageJSON.contributes?.iconThemes ?? []).map((theme: { id: string; path: string }) => ({ extension, theme })));
  const chosen = contributions.find(entry => entry.theme.id === selected);
  // Remove old resource roots when icons are disabled or the selected extension disappears.
  webview.options = { ...webview.options, localResourceRoots: [media, ...(chosen ? [chosen.extension.extensionUri] : [])] };
  if (!chosen) { return status; }
  const uri = vscode.Uri.joinPath(chosen.extension.extensionUri, chosen.theme.path);
  const directory = vscode.Uri.joinPath(uri, '..');
  const theme = parseIconTheme(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
  const kind = vscode.window.activeColorTheme.kind;
  const variant = kind === vscode.ColorThemeKind.Light ? 'light'
   : kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight ? 'highContrast' : undefined;
  const resource = (relative: string) => webview.asWebviewUri(vscode.Uri.joinPath(directory, relative)).toString();
  const languages = vscode.extensions.all.flatMap(extension => extension.packageJSON.contributes?.languages ?? []) as { id: string; filenames?: string[]; extensions?: string[] }[];
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
   let icon: FileThemeIcon | undefined;
   if (definition?.iconPath) { icon = { image: resource(definition.iconPath) }; }
   else if (definition?.fontCharacter) {
    const font = theme.fonts?.find(f => f.id === definition.fontId) ?? theme.fonts?.[0];
    if (font?.src[0]) { icon = { character: decodeFontCharacter(definition.fontCharacter), font: resource(font.src[0].path), color: definition.fontColor, size: definition.fontSize ?? font.size }; }
   }
   return { ...file, ...(icon ? { icon } : {}) };
  };
  return { ...status, staged: status.staged.map(decorate), unstaged: status.unstaged.map(decorate) };
 } catch { return status; } // An unavailable theme must not hide Git changes.
}
