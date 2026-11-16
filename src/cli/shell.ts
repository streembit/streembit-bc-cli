// Interactive CLI engine + command registry, the shell of the node's CLI without the node commands

import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { printLine, printError, toErrorMessage, EXIT_INTERRUPTED } from './output';

export type CommandHandler = (args: string[]) => Promise<void> | void;

export type CommandDef = {
    name: string;
    summary: string;
    usage?: string;
    handler: CommandHandler;
};

const registry = new Map<string, CommandDef>();

// ---- Command registration helpers ----
export function registerCommand(cmd: CommandDef) {
    registry.set(cmd.name.toLowerCase(), cmd);
}

export function listCommands(): CommandDef[] {
    return Array.from(registry.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getCommand(name: string): CommandDef | undefined {
    return registry.get((name || '').toLowerCase());
}

export function clearCommands(): void {
    registry.clear();
}

/** Run one command by name; an unknown command and a handler that throws are printed as errors, never thrown */
export async function runCommand(cmd: string, args: string[]): Promise<void> {
    const def = getCommand(cmd);
    if (!def) {
        printError(`Unknown command: ${cmd}. Type 'help' to see available commands.`);
        return;
    }
    try {
        await def.handler(args);
    } catch (e) {
        printError(`Command '${cmd}' failed: ${toErrorMessage(e)}`);
    }
}

// The shell's readline while the shell runs; null in one-shot mode
let shellReadline: readline.Interface | null = null;

/**
 * Ask a question through the shell's own readline, so that the answer goes to the question alone and is not also
 * read as a command. A second readline on the same input would hand the typed line to both.
 * @returns The answer, or null when no shell is running (one-shot mode)
 */
export function askShell(question: string): Promise<string> | null {
    const rl = shellReadline;
    if (!rl) {
        return null;
    }
    return new Promise(resolve => {
        answering = true;
        rl.question(question, answer => {
            answering = false;
            resolve(answer);
        });
    });
}

/** True while the interactive shell runs, false in one-shot mode: a command that keeps working in the background needs the shell to stay */
export function shellRunning(): boolean {
    return shellReadline !== null;
}

// True while a question of askShell waits for its answer, and the newest command line of the shell's history
let answering = false;
let newestCommand: string | undefined;

// The number of commands the shell is running; above zero an interrupt abandons a command
let running = 0;

export async function startRepl(prompt: string = 'streembit> '): Promise<void> {
    const rl = readline.createInterface({ input, output, terminal: true });
    shellReadline = rl;
    answering = false;
    newestCommand = undefined;
    running = 0;

    // An answer is not a command: it is taken out of the history again, so that the up arrow never brings back a
    // recovery phrase or a confirmation. The 'history' event is readline's documented place to keep a line out.
    rl.on('history', (history: string[]) => {
        if (answering && history.length > 0 && history[0] !== newestCommand) {
            history.shift();
        } else {
            newestCommand = history[0];
        }
    });

    // One command at a time. A line typed while a command is still running waits its turn and runs when that
    // command has finished, as type-ahead does in a shell. Two commands started together would both ask their
    // questions through the one readline, which answers only the first: the second would wait for ever.
    let queue: Promise<void> = Promise.resolve();

    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            if (running === 0) {
                rl.setPrompt(prompt);
                rl.prompt();
            }
            return;
        }

        running++;
        queue = queue.then(async () => {
            try {
                const [cmd, ...rest] = splitArgs(trimmed);
                await runCommand(cmd, rest);
            } finally {
                running--;
            }
            // The prompt comes back when nothing is left to run
            if (running === 0 && shellReadline === rl) {
                rl.setPrompt(prompt);
                rl.prompt();
            }
        });
    });

    // Ctrl+C. While a command runs or waits for an answer it abandons that command, and the shell ends as
    // interrupted, never as a success. At the idle prompt it leaves the shell, as exit does.
    rl.on('SIGINT', () => {
        if (running > 0) {
            output.write('\n');
            process.exit(EXIT_INTERRUPTED);
        }
        rl.close();
    });

    // The input ended or the shell was left. A command that was still running then did not complete: exit code 1
    rl.on('close', () => {
        shellReadline = null;
        printLine('Goodbye!');
        process.exit(running > 0 ? 1 : 0);
    });

    rl.setPrompt(prompt);
    rl.prompt();
}

// Simple shell-like arg splitter (supports quoted strings)
export function splitArgs(s: string): string[] {
    const args: string[] = [];
    let cur = '';
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        if (quote) {
            if (ch === quote) {
                quote = null;
            } else {
                cur += ch;
            }
            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch as '"' | "'";
            continue;
        }

        if (/\s/.test(ch)) {
            if (cur) {
                args.push(cur);
                cur = '';
            }
            continue;
        }

        cur += ch;
    }

    if (cur) args.push(cur);
    return args;
}
