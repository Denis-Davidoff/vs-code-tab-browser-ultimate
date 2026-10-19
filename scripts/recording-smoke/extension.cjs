// Runs inside an isolated VS Code extension host; launched by check-recording.mjs.
const vscode = require('vscode'), fs = require('fs'), http = require('http'), assert = require('assert/strict');
const repo = process.env.AI_BROWSER_RECORDING_REPO, root = process.env.AI_BROWSER_RECORDING_OUTPUT;
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async condition => {
    const deadline = Date.now() + 15000;
    while (!condition()) {
        if (Date.now() > deadline) throw Error('Timed out waiting for recording transition');
        await wait(10);
    }
};
exports.activate = function (context) { setTimeout(() => run(context), 100); };
async function run(context) {
    const report = { checks: [] };
    let browser, recording, chat, mcp, server, tab;
    const previousClipboard = await vscode.env.clipboard.readText();
    try {
        const { BrowserController } = require(__dirname + '/out/browser/browserController');
        const { BrowserRecording } = require(__dirname + '/out/browser/recording');
        const { ChatViewProvider } = require(__dirname + '/out/chat/chatView');
        const { McpServer } = require(__dirname + '/out/mcp/mcpServer');
        browser = new BrowserController();
        const testContext = Object.create(context);
        Object.defineProperty(testContext, 'extensionUri', { value: vscode.Uri.file(repo) });
        recording = new BrowserRecording(testContext, browser);
        chat = new ChatViewProvider(testContext, browser, () => undefined, recording);
        chat._registry.detect = async () => {};
        context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiBrowser.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }));
        recording.destination = id => chat.recordingDestination(id);
        recording.createEncoder = id => chat.createRecordingEncoder(id);
        for (const action of ['pause', 'resume', 'stop'])
            context.subscriptions.push(vscode.commands.registerCommand('aiBrowser.recording.' + action, () => recording.control(action)));
        server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<body style="background:#123;color:white;font:28px sans-serif"><h1>Live recording integration</h1><canvas width="640" height="360"></canvas><script>const c=document.querySelector("canvas").getContext("2d");function draw(t){c.fillStyle="#123";c.fillRect(0,0,640,360);c.fillStyle="#4de";c.fillRect((t/4)%500,100,100,100);c.fillStyle="white";c.fillText(Math.round(t),20,40);requestAnimationFrame(draw)}requestAnimationFrame(draw)</script>'); });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        tab = await vscode.window.openBrowserTab('http://127.0.0.1:' + server.address().port);
        await wait(1500);
        const token = require('crypto').randomBytes(24).toString('hex');
        mcp = new McpServer(browser, token, 'recording-test', '0.0.1', new Map(), recording);
        await mcp.start([43391, 43392, 43393]);
        let rpcId = 0;
        async function client(chatId) {
            let session;
            async function rpc(method, params, requestId = ++rpcId, notification = false) { const response = await fetch(mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(session ? { 'Mcp-Session-Id': session } : {}), ...(chatId ? { 'X-AI-Browser-Chat': chatId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params }) }); const sid = response.headers.get('mcp-session-id'); if (sid)
                session = sid; if (response.status === 202) return undefined;
                const data = await response.json(); if (data.error)
                throw Error(JSON.stringify(data.error)); return data.result; }
            await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex', version: '1' } });
            const call = async (name, args = {}) => { const result = await rpc('tools/call', { name, arguments: args }); if (result.isError)
                throw Error(result.content.map(c => c.text).join('\n')); return JSON.parse(result.content.find(c => c.type === 'text').text); };
            call.rpc = rpc;
            return call;
        }
        const original = chat._active;
        const own = await client(original.chat.id);
        const external = await client();
        // Cancel through the real MCP transport while encoder initialization is pending.
        const originalRequest = recording._request.bind(recording);
        let releaseInit;
        const initGate = new Promise(resolve => { releaseInit = resolve; });
        let waitingInit = false;
        recording._request = async (run, type, ...args) => {
            if (type === 'init') { waitingInit = true; await initGate; }
            return originalRequest(run, type, ...args);
        };
        try {
            const requestId = ++rpcId;
            const pending = external.rpc('tools/call', { name: 'browser_recording_start', arguments: {} }, requestId);
            await until(() => waitingInit);
            await external.rpc('notifications/cancelled', { requestId }, undefined, true);
            const cancelled = await pending;
            assert.equal(cancelled.isError, true);
            assert.match(cancelled.content[0].text, /cancelled/);
            assert.equal(recording._active, undefined);
            report.checks.push('MCP cancellation during pending startup releases recording');
        } finally {
            recording._request = originalRequest;
            releaseInit();
        }
        let started = await own('browser_recording_start');
        assert.equal(recording._active.profile.width, 2560, 'new recordings default to high quality');
        await chat._receive({ type: 'saveFeatureAi', settings: {}, recordingQuality: 'maximum' });
        assert.ok(started.frames > 0, 'start returns only after an encoded frame');
        assert.equal(started.delivery, 'chat');
        report.checks.push('MCP starts real CDP and webview encoder');
        await assert.rejects(() => external('browser_recording_start'), /already/);
        await assert.rejects(() => external('browser_recording_status', { id: started.id }), /not found/);
        report.checks.push('second recording and other-session access rejected');
        await wait(1800);
        await vscode.commands.executeCommand('aiBrowser.recording.pause');
        await wait(250);
        const paused = await own('browser_recording_status', { id: started.id });
        assert.equal(paused.state, 'paused');
        await wait(1200);
        const pausedAgain = await own('browser_recording_status', { id: started.id });
        assert.equal(pausedAgain.frames, paused.frames);
        assert.equal(pausedAgain.durationSeconds, paused.durationSeconds);
        report.checks.push('toolbar pause stops frames and duration');
        await own('browser_recording_resume', { id: started.id });
        assert.equal(recording._active.profile.width, 2560, 'changing quality does not resize a running recording');
        await wait(1800);
        assert.ok((await own('browser_recording_status', { id: started.id })).frames > paused.frames, 'new browser frames arrive after resume');
        chat.newChat();
        assert.notEqual(chat._active, original);
        await vscode.commands.executeCommand('aiBrowser.recording.stop');
        const finished = await own('browser_recording_status', { id: started.id });
        assert.equal(finished.state, 'completed');
        assert.ok(finished.durationSeconds > 3.1 && finished.durationSeconds < 4.2, 'paused time excluded and static time retained');
        assert.equal(finished.attachedToChat, true);
        assert.ok(finished.bytes > 0);
        assert.equal(fs.statSync(finished.file).size, finished.bytes);
        assert.ok(original.attachments.some(a => a.chip.kind === 'video' && a.file.fsPath === finished.file));
        assert.ok(!chat._active.attachments.some(a => a.chip.kind === 'video'));
        report.chat = finished;
        report.checks.push('toolbar stop finalized video; MCP status finds result; attachment remains in original chat');
        const manual = await recording.start();
        assert.equal(recording._active.profile.width, 3840, 'saved quality applies to the next recording');
        await wait(1600);
        await recording.control('pause');
        const other = await vscode.window.openBrowserTab('http://127.0.0.1:' + server.address().port + '/other');
        try {
            await recording.control('resume');
            assert.equal(recording._active.tab, tab);
            await recording.control('pause');
        } finally { await other.close(); }
        const manualDone = await recording.control('stop');
        assert.equal(manualDone.state, 'completed');
        assert.equal(manualDone.delivery, 'clipboard');
        assert.equal(manualDone.clipboardCopied, true);
        assert.equal(await vscode.env.clipboard.readText(), manualDone.file);
        report.manual = manualDone;
        report.checks.push('manual resume after focusing another tab; original source retained; stop while paused; clipboard delivery');
        const ext = await external('browser_recording_start');
        await wait(1600);
        const extDone = await external('browser_recording_stop', { id: ext.id });
        assert.equal(extDone.clipboardCopied, true);
        assert.ok(extDone.durationSeconds > 1.3 && extDone.durationSeconds < 2, 'static recording retains its duration');
        assert.equal(extDone.attachedToChat, false);
        report.external = extDone;
        report.checks.push('external MCP defaults to clipboard delivery');
        const closing = await external('browser_recording_start');
        await wait(500);
        let releaseFrame, releaseFinish, waitingFrame = false, waitingFinish = false;
        const frameGate = new Promise(resolve => { releaseFrame = resolve; });
        const finishGate = new Promise(resolve => { releaseFinish = resolve; });
        recording._request = async (run, type, ...args) => {
            if (type === 'stop') { waitingFinish = true; await finishGate; }
            const reply = await originalRequest(run, type, ...args);
            if (type === 'frame' && !waitingFrame) { waitingFrame = true; await frameGate; }
            return reply;
        };
        try {
            // Force a real page frame into the race even when the page is static or throttled.
            const activeSource = recording._active;
            const screenshot = await recording._send(activeSource, 'Page.captureScreenshot', { format: 'png' });
            void recording._frame(activeSource, { sessionId: 0, data: screenshot.data }).catch(error => recording._fail(activeSource, error));
            await until(() => waitingFrame);
            const active = recording._active;
            await tab.close();
            await until(() => waitingFinish);
            releaseFrame();
            await until(() => !active.busyFrame);
            releaseFinish();
            await until(() => !recording._active);
            const closed = await external('browser_recording_status', { id: closing.id });
            assert.equal(closed.state, 'completed');
            assert.ok(fs.existsSync(closed.file));
            assert.equal(fs.statSync(closed.file).size, closed.bytes);
            report.checks.push('closing the source with a frame in flight finalizes the video');
        } finally {
            recording._request = originalRequest;
            releaseFrame(); releaseFinish();
        }
        tab = await vscode.window.openBrowserTab('http://127.0.0.1:' + server.address().port);
        await wait(1500);
        const hidden = await external('browser_recording_start');
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await until(() => !chat._view.visible);
        await wait(2500);
        const hiddenResult = await external('browser_recording_stop', { id: hidden.id });
        assert.equal(hiddenResult.state, 'completed');
        assert.ok(hiddenResult.bytes > 0);
        assert.ok(hiddenResult.durationSeconds > 2, 'hidden encoder keeps video time');
        const startedHidden = await external('browser_recording_start');
        assert.equal(chat._view.visible, false, 'starting another recording does not reveal the chat');
        await wait(1200);
        assert.equal((await external('browser_recording_stop', { id: startedHidden.id })).state, 'completed');
        assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).every(tab => tab.label !== 'Browser recording'));
        report.checks.push('recording and starting while chat is hidden; no recording editor tab is created');
        report.ok = true;
    }
    catch (e) {
        report.error = String(e.stack || e);
    }
    finally {
        try {
            await vscode.env.clipboard.writeText(previousClipboard);
        }
        catch { }
        if (mcp)
            mcp.dispose();
        if (recording)
            recording.dispose();
        if (chat)
            chat.dispose();
        if (browser)
            browser.dispose();
        if (tab)
            await tab.close();
        if (server)
            server.close();
        fs.writeFileSync(root + '/integration-result.json', JSON.stringify(report, null, 2));
        setTimeout(() => vscode.commands.executeCommand('workbench.action.closeWindow'), 500);
    }
}
