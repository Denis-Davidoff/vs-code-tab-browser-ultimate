/** Bounded input accepted from an authenticated remote workspace owner. Never raw CDP. */
export type RemoteBrowserInput =
 | { action: 'click'; x: number; y: number; button: 'left' | 'right'; count: number }
 | { action: 'move'; x: number; y: number }
 | { action: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
 | { action: 'text'; text: string }
 | { action: 'key'; key: string; modifiers: number }
 | { action: 'navigate'; url: string }
 | { action: 'reload' | 'back' | 'forward' | 'close' };
export const remoteKeys = ['Backspace','Tab','Enter','Escape','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','a','c','v','x','z','y'];
export function readRemoteBrowserInput(value: unknown): RemoteBrowserInput | undefined {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return;
 const v = value as Record<string,unknown>;
 const number = (k: string, max: number) => typeof v[k] === 'number' && Number.isFinite(v[k]) && Math.abs(v[k] as number) <= max;
 const point = () => number('x',1) && number('y',1) && (v.x as number)>=0 && (v.y as number)>=0;
 let keys: string[];
 switch(v.action) {
  case 'click': if(!point() || !['left','right'].includes(v.button as string) || ![1,2].includes(v.count as number)) return; keys=['action','x','y','button','count']; break;
  case 'move': if(!point()) return; keys=['action','x','y']; break;
  case 'scroll': if(!point() || !number('deltaX',2000) || !number('deltaY',2000)) return; keys=['action','x','y','deltaX','deltaY']; break;
  case 'text': if(typeof v.text!=='string' || !v.text || v.text.length>4000) return; keys=['action','text']; break;
  case 'key': if(!remoteKeys.includes(v.key as string) || !Number.isInteger(v.modifiers) || (v.modifiers as number)<0 || (v.modifiers as number)>15) return; keys=['action','key','modifiers']; break;
  case 'navigate': {
   if(typeof v.url!=='string' || v.url.length>4096) return;
   try { const url=new URL(v.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return; } catch { return; }
   keys=['action','url']; break;
  }
  case 'reload': case 'back': case 'forward': case 'close': keys=['action'];break;
  default: return;
 }
 if(Object.keys(v).some(k=>!keys.includes(k))) return;
 return v as RemoteBrowserInput;
}

/** Do not offer the viewer itself as a stream source (including localhost/LAN aliases). */
export function isExchangeControlPage(value: string, server: string, pointId: string): boolean {
 try {
  const page=new URL(value),relay=new URL(server);
  relay.protocol=relay.protocol==='wss:'?'https:':relay.protocol==='ws:'?'http:':relay.protocol;
  const path=page.pathname.replace(/\/+$/,'');
  if(path===`/workspace/${pointId}` || (path==='/remote-chat/index.html'&&page.searchParams.get('point')===pointId))return true;
  const host=(url:URL)=>['localhost','127.0.0.1','[::1]'].includes(url.hostname)?'loopback':url.hostname;
  const sameServer=page.protocol===relay.protocol&&host(page)===host(relay)&&page.port===relay.port;
  return sameServer && (/^\/workspace\/[^/]+$/.test(path)||path==='/remote-chat/index.html');
 }catch{return false;}
}
