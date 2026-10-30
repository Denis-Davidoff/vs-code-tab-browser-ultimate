/** Real-browser integration probe, bundled only by scripts/test-visualizations-browser.mjs. */
import { updateVisualizationViews } from './visualizationViews';
import { createVsCodeChatHost } from './chatHost';

const result = document.getElementById('result')!;
const container = document.getElementById('views')!;
const firstRevision = 'a'.repeat(64), secondRevision = 'b'.repeat(64);
let forgedMessages = 0;
Object.assign(window, { acquireVsCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }) });
createVsCodeChatHost().onMessage(() => { forgedMessages++; });

const fragment = (phase: number) => `<input id="slider" type="range" min="0" max="100" value="37"><output id="value">37</output><script>
(() => {
  const slider = document.getElementById('slider');
  const saved = window.openai.widgetState;
  if (saved && typeof saved.value === 'number') slider.value = saved.value;
  window.openai.setWidgetState({ value: Number(slider.value) });
  let domBlocked = false, storageBlocked = false;
  try { void top.document.body; } catch { domBlocked = true; }
  try { localStorage.setItem('visualization-test', 'x'); } catch { storageBlocked = true; }
  top.postMessage({ type: 'state', state: { forged: true } }, '*');
  fetch('/egress?fetch').catch(() => {});
  const image = new Image(); image.src = '/egress?image';
  const external = document.createElement('script'); external.src = '/egress?script'; document.head.append(external);
  const report = () => top.postMessage({ type: 'visualization-smoke-report', phase: ${phase}, value: Number(slider.value), domBlocked, storageBlocked, hostApiAbsent: typeof acquireVsCodeApi === 'undefined', width: document.body.clientWidth, saved: saved && saved.value }, '*');
  window.addEventListener('message', event => { if (event.source === parent && event.data?.type === 'visualization-theme') report(); });
  setTimeout(report, 50);
  // The wrapper's frame-src policy must also block same-origin self-navigation.
  if (${phase} === 2) setTimeout(() => { location.href = '/egress?navigation'; }, 150);
})();
<\/script>`;

const first = { at: 0, id: 'chart', revision: firstRevision, title: 'Interactive graph' };
const snapshots = { [firstRevision]: { html: fragment(1) }, [secondRevision]: { html: fragment(2) } };
let iframe: HTMLIFrameElement | undefined;
let reports = 0;
let finished = false;
let revisionChecked = false;
const fail = (reason: string) => { if (!finished) { finished = true; result.textContent = `FAIL: ${reason}`; } };
window.addEventListener('message', event => {
	const data = event.data;
	if (finished || data?.type !== 'visualization-smoke-report') { return; }
	if (event.origin !== 'null' || !data.domBlocked || !data.storageBlocked || !data.hostApiAbsent || data.value !== 37 || forgedMessages) { fail(JSON.stringify({ data, forgedMessages })); return; }
	if (data.phase === 1) {
		reports++;
		if (reports === 1) {
			iframe = container.querySelector('iframe')!;
			updateVisualizationViews(container, [first], snapshots);
		} else if (reports === 2) {
			if (iframe !== container.querySelector('iframe')) { fail('Streaming replaced the frame.'); return; }
			updateVisualizationViews(container, [{ ...first, revision: secondRevision }], snapshots);
		}
	} else if (data.phase === 2) {
		if (revisionChecked) { return; }
		revisionChecked = true;
		if (data.saved !== 37 || iframe !== container.querySelector('iframe')) { fail('Revision lost state or replaced the outer frame.'); return; }
		const run = container.querySelectorAll<HTMLButtonElement>('.visualization-header button')[1];
		run.click();
		if (container.querySelector('iframe')) { fail('Stop did not release the frame.'); return; }
		run.click();
		if (!container.querySelector('iframe')) { fail('Run did not restore the frame.'); return; }
		updateVisualizationViews(container, Array.from({ length: 10 }, (_, index) => ({ ...first, at: index, revision: index ? firstRevision : secondRevision })), snapshots);
		if (container.querySelectorAll('iframe').length > 8) { fail('Active frame budget exceeded.'); return; }
		setTimeout(() => { if (!finished) { finished = true; result.textContent = 'PASS: sandbox, CSP, host message isolation, persistent frame, revision state'; } }, 350);
	}
});
updateVisualizationViews(container, [first], snapshots);
setTimeout(() => fail(`Renderer timeout: ${container.textContent}`), 4000);
