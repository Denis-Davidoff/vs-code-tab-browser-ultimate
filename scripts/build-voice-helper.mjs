// Builds bin/ai-browser-voice from native/voice/voice.swift: one universal (arm64 + x86_64)
// binary, macOS 26 or later, ad-hoc signed by the linker. Checked in like the icon font, so a
// build of the extension needs no Swift toolchain. See "Voice messages" in CLAUDE.md.
//
//   node ./scripts/build-voice-helper.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = 'native/voice/voice.swift';
const output = 'bin/ai-browser-voice';
const work = mkdtempSync(join(tmpdir(), 'ai-browser-voice-'));
try {
	const parts = ['arm64', 'x86_64'].map(arch => {
		const out = join(work, arch);
		execFileSync('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', `${arch}-apple-macos26.0`, source, '-o', out], { stdio: 'inherit' });
		return out;
	});
	mkdirSync('bin', { recursive: true });
	execFileSync('lipo', ['-create', ...parts, '-output', output], { stdio: 'inherit' });
	execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
	console.log(`wrote ${output}`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
