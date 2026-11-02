import type { ToolEntry } from './chatProtocol';

/** A read-only terminal projection of captured CLI output. It never starts or writes to a process. */
export class ShellOutput {
	private _output?: string;
	private _status?: string;
	private _gone = false;

	public update(entry: ToolEntry | undefined): string {
		if (!entry) {
			if (this._gone) { return ''; }
			this._gone = true;
			return '\r\n[This command is no longer available in the open conversation.]\r\n';
		}
		this._gone = false;
		const output = entry.output ?? '';
		const first = this._output === undefined;
		const redraw = !first && !output.startsWith(this._output!);
		let text = '';
		if (first || redraw) {
			text += (redraw ? '\x1b[2J\x1b[H' : '') + 'Bash output · read only\r\n';
			text += 'Captured output from the agent CLI; interactive input is unavailable.\r\n';
			text += terminalLines(`$ ${entry.input ?? entry.detail ?? entry.name}`) + '\r\n\r\n';
		}
		text += terminalLines(first || redraw ? output : output.slice(this._output!.length));
		this._output = output;
		const status = `${entry.status}:${entry.exitCode ?? ''}`;
		if (entry.status !== 'running' && (status !== this._status || redraw)) {
			text += `\r\n[${entry.status}${entry.exitCode !== undefined ? ` · exit ${entry.exitCode}` : ''}]\r\n`;
		}
		this._status = status;
		return text;
	}
}

function terminalLines(text: string): string { return text.replace(/\r?\n/g, '\r\n'); }
