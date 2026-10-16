/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A chat written out as Markdown, for the chat's "Continue in …": the other
 * agent is handed the file and reads it before its first answer. A leaf module,
 * under test.
 *
 * What goes in is what the next agent needs to carry on: what the user asked,
 * what the agent answered, and what it did — commands with their exit code,
 * files read and edited, agents and their reports — one line each, since the
 * next agent can look at the files itself. Thinking and notices stay out.
 * Anything quoted from a tool goes in a fence longer than any backtick run
 * inside it, the rule `fenced` in `reportFormat.ts` follows (written again here:
 * a leaf takes no relative value import).
 */

import type { ChatEntry } from './chatProtocol';

/** The longest piece of a tool's output carried over; the rest is on disk or in the agent's reach. */
const quotedLimit = 2_000;

export function chatTranscript(title: string, agentName: string, entries: readonly ChatEntry[], now: Date): string {
	const lines = [
		`# ${oneLine(title) || 'Chat'}`,
		'',
		`A conversation with ${agentName}, written out by the AI Browser chat on ${now.toISOString()} so that another agent can carry it on.`,
	];
	let speaker: 'user' | 'agent' | undefined;
	const heading = (who: 'user' | 'agent') => {
		if (speaker !== who) {
			lines.push('', who === 'user' ? '## User' : `## ${agentName}`, '');
			speaker = who;
		}
	};
	for (const entry of entries) {
		switch (entry.kind) {
			case 'user':
				heading('user');
				lines.push(entry.text || '(no text)');
				if (entry.attachments.length) {
					lines.push('', `Attached: ${entry.attachments.map(oneLine).join(', ')}`);
				}
				break;
			case 'assistant':
				heading('agent');
				// A blank line first: after a tool list, Markdown reads the text as
				// part of the last item.
				lines.push('', entry.text, '');
				break;
			case 'tool': {
				heading('agent');
				const status = entry.status === 'failed' ? (entry.exitCode !== undefined ? ` (exit code ${entry.exitCode})` : ' (failed)')
					: entry.status === 'stopped' ? ' (stopped)' : entry.status === 'running' ? ' (still running)' : '';
				const what = entry.tool === 'command' ? `Ran \`${oneLine(entry.input ?? entry.detail ?? '')}\``
					: entry.tool === 'agent' ? `Started an agent: ${oneLine(entry.detail ?? entry.name)}`
						: `${entry.name}${entry.detail ? ` ${oneLine(entry.detail)}` : ''}`;
				lines.push(`- ${what}${status}`);
				const report = entry.tool === 'agent' ? entry.agent?.summary ?? entry.output : undefined;
				if (report) {
					lines.push('', fenced(clipped(report)), '');
				}
				break;
			}
			case 'error':
				lines.push('', `Error: ${oneLine(entry.text)}`, '');
				break;
			default:
				break;
		}
	}
	return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** `chat-<title words>-<YYYYMMDD-HHMMSS>.md`, in the names the report sweep takes. */
export function transcriptFileName(title: string, now: Date): string {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `chat-${slug ? `${slug}-` : ''}${stamp}.md`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function clipped(text: string): string {
	return text.length > quotedLimit ? `${text.slice(0, quotedLimit)}\n…` : text;
}

function fenced(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return `${fence}text\n${text}\n${fence}`;
}
