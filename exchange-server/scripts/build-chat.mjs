import {build} from 'esbuild';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=`${root}exchange-server/apps/web/public/remote-chat/`;
await mkdir(output,{recursive:true});
await build({entryPoints:{host:`${root}preview-src/serverChatHost.ts`,chat:`${root}preview-src/chat.ts`,codicon:`${root}node_modules/@vscode/codicons/dist/codicon.css`,xterm:`${root}node_modules/@xterm/xterm/css/xterm.css`},outdir:output,bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,loader:{'.ttf':'dataurl','.csv':'text'},define:{__TERMINAL__:'true'},logLevel:'info'});
for(const [source,target] of [[`${root}media/chat.css`,'chat.css'],[`${root}media/liquid-loader.css`,'liquid-loader.css'],[`${root}media/appearance.css`,'appearance.css'],[`${root}chrome-extension/sidepanel.css`,'sidepanel.css'],[`${root}exchange-server/chat-assets/index.html`,'index.html'],[`${root}exchange-server/chat-assets/web-chat.css`,'web-chat.css']])await copyFile(source,output+target);
// All files in one renderer release share a content-derived cache key. Include
// imported styles too, so a mobile browser cannot mix old layout and new code.
const assets=['host.js','chat.js','codicon.css','xterm.css','chat.css','liquid-loader.css','appearance.css','sidepanel.css','web-chat.css'];
const hash=createHash('sha256');
for(const name of assets)hash.update(name).update(await readFile(output+name));
const version=hash.digest('hex').slice(0,16);
let html=await readFile(output+'index.html','utf8');
html=html.replace(/((?:href|src)=")([^"?]+\.(?:css|js))"/g,`$1$2?v=${version}"`);
await writeFile(output+'index.html',html);
const css=await readFile(output+'chat.css','utf8');
await writeFile(output+'chat.css',css.replace(/(@import url\("\.\/)([^"?]+\.css)("\);)/g,`$1$2?v=${version}$3`));
