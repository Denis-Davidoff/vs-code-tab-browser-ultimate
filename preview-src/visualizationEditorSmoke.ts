/** Real VS Code webview probe, bundled only by scripts/test-visualizations-editor.mjs. */
import { updateVisualizationViews } from './visualizationViews';
declare const __SMOKE_HTML__: string;
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const api = acquireVsCodeApi();
const container = document.getElementById('views')!;
const reference = { at: 0, id: 'editor-probe', revision: 'a'.repeat(64), title: 'Visualization editor probe' };
let complete = false;
let firstFrame: HTMLIFrameElement | undefined;
let pendingRevision = false;
const finish = (message: unknown) => { if (!complete) { complete = true; api.postMessage(message); } };
window.addEventListener('error', event => finish({ ok: false, error: event.message }));
const NativeChannel = window.MessageChannel;
window.MessageChannel = class extends NativeChannel {
	constructor() {
		super();
		this.port1.addEventListener('message', event => {
			const state = event.data?.type === 'state' ? event.data.state : undefined;
			if (!state?.editorProbe || complete) { return; }
			if (!state.domBlocked || !state.storageBlocked || state.value !== 2.5 || state.points < 100) { finish({ ok: false, error: 'Graph or sandbox check failed.', state }); return; }
			if (state.editorProbe === 1 && !pendingRevision) {
				pendingRevision = true;
				// Let the production listener record the state before committing a new revision.
				setTimeout(() => updateVisualizationViews(container, [{ ...reference, revision: 'b'.repeat(64) }], snapshots), 30);
			} else if (state.editorProbe === 2) {
				finish({ ok: firstFrame === container.querySelector('iframe'), state, crossOriginIsolated: window.crossOriginIsolated,
					renderer: document.querySelector<HTMLMetaElement>('meta[name="ai-browser-visualization-renderer"]')?.content });
			}
		});
	}
};
function html(phase: number): string {
	return __SMOKE_HTML__ + `<script>(()=>{
const slider=document.getElementById('sine-a');
if(!slider) throw new Error('Graph slider is missing.');
${phase === 1 ? "slider.value='2.5';slider.dispatchEvent(new Event('input'));" : ''}
let domBlocked=false,storageBlocked=false;
try{void parent.document.body;}catch{domBlocked=true;}
try{localStorage.setItem('probe','x');}catch{storageBlocked=true;}
window.openai.setWidgetState({a:Number(slider.value),value:Number(slider.value),points:(document.getElementById('sine-curve').getAttribute('d')||'').length,editorProbe:${phase},domBlocked,storageBlocked});
})();<\/script>`;
}
const snapshots = { ['a'.repeat(64)]: { html: html(1) }, ['b'.repeat(64)]: { html: html(2) } };
updateVisualizationViews(container, [reference], snapshots);
firstFrame = container.querySelector('iframe')!;
setTimeout(() => finish({ ok: false, error: 'Editor visualization timed out.', status: container.textContent }), 15000);
