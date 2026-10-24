import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=`${root}exchange-server/apps/web/public/remote-chat/`;
await mkdir(output,{recursive:true});
await build({entryPoints:{host:`${root}preview-src/serverChatHost.ts`,chat:`${root}preview-src/chat.ts`,codicon:`${root}node_modules/@vscode/codicons/dist/codicon.css`},outdir:output,bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,loader:{'.ttf':'dataurl','.csv':'text'},logLevel:'info'});
for(const [source,target] of [[`${root}media/chat.css`,'chat.css'],[`${root}media/liquid-loader.css`,'liquid-loader.css'],[`${root}media/appearance.css`,'appearance.css'],[`${root}chrome-extension/sidepanel.css`,'sidepanel.css'],[`${root}exchange-server/chat-assets/index.html`,'index.html'],[`${root}exchange-server/chat-assets/web-chat.css`,'web-chat.css']])await copyFile(source,output+target);
