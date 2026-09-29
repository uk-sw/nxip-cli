import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceSession } from '../src/ssh.js';

/**
 * The Cisco fixtures under test/fixtures/cisco are session transcripts:
 * every "### <command>" line starts that command's output, and lines
 * beginning "!!" are the file's own header. One file per platform, read
 * here into a command-to-output map and served through a fake session so
 * readDevice() runs exactly the commands it would run over SSH.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'cisco');

export function loadTranscript(name: string): Map<string, string> {
  const text = readFileSync(join(FIXTURES, name), 'utf-8');
  const outputs = new Map<string, string>();
  let command: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (command !== null) outputs.set(command, lines.join('\n'));
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('!!')) continue;
    const header = /^### (.+)$/.exec(line);
    if (header) {
      flush();
      command = header[1].trim();
      lines = [];
      continue;
    }
    if (command !== null) lines.push(line);
  }
  flush();
  return outputs;
}

/** A DeviceSession that answers from a transcript and records what was asked. */
export class TranscriptSession implements DeviceSession {
  readonly commands: string[] = [];
  closed = false;

  constructor(
    private readonly outputs: Map<string, string>,
    /** What the device says to a command the transcript does not hold. IOS's wording by default. */
    private readonly unknown = "% Invalid input detected at '^' marker."
  ) {}

  async run(command: string): Promise<string> {
    this.commands.push(command);
    if (this.closed) throw new Error('session closed');
    if (command === 'terminal length 0') return '';
    return this.outputs.get(command) ?? `${' '.repeat(22)}^\n${this.unknown}\n`;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function transcriptSession(name: string): TranscriptSession {
  return new TranscriptSession(loadTranscript(name));
}
