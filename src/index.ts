#!/usr/bin/env node
/**
 * Streembit CLI, entry point of the streembit-cli command: the wallet, transactions and chain queries.
 *
 * streembit-cli <command> [args] runs one command and exits; without arguments the interactive shell starts.
 *
 * A client only: no node, no database, no identity. The wallet file is kept under WALLET_DATA_DIR (default
 * <home>/.streembit/wallet). Every read goes to the read mirror, READ_URL, which is required: without it the
 * CLI exits at start. The Accountable Node, NODE_URL (default http://127.0.0.1:8080), receives signed
 * transactions and the multisig requests, which it alone keeps. The network name is learned from the mirror; when the mirror does not
 * answer the shell still starts, so an existing wallet can be opened and shown offline. Creating or restoring
 * a wallet needs the mirror: the wallet file records its network, and it is never a guessed one.
 */

import { configureApi, configureReadApi, fetchStatus } from 'streembit-bc-sdk/api';
import { NodeUrl, ReadUrl, DataDir, setNetwork } from './config';
import { registerCommand, runCommand, startRepl } from './cli/shell';
import { printLine, printedErrors, EXIT_INTERRUPTED } from './cli/output';
import { helpCommand } from './commands/help';
import { exitCommand } from './commands/exit';
import { walletCommands, describeApiError } from './commands/wallet';
import { multisigCommands } from './commands/multisig';

/** Asks the mirror for its status, keeps the network name and returns the line that describes the mirror; an unreachable mirror is described, not thrown */
async function readMirrorStatus(): Promise<string> {
    try {
        const status = await fetchStatus();
        setNetwork(status.network);
        return `${ReadUrl()} (${status.network}, chain ${status.chainId}, height ${status.height})`;
    } catch (error) {
        return `${ReadUrl()} (not reachable: ${describeApiError(error)}; network not known)`;
    }
}

async function main(): Promise<void> {
    // ReadUrl() throws when READ_URL is not set: the CLI does not run without a read mirror
    configureReadApi(ReadUrl());
    configureApi(NodeUrl());

    registerCommand(helpCommand);
    registerCommand(exitCommand);
    for (const command of [...walletCommands, ...multisigCommands]) {
        registerCommand(command);
    }

    // One-shot mode: streembit-cli <command> [args] runs the command and exits, 0 on success and 1 when it printed an error
    const [command, ...args] = process.argv.slice(2);
    if (command) {
        await runCommand(command === '--help' || command === '-h' ? 'help' : command, args);
        // The exit code is set and the process ends by itself once its output is written. process.exit() would not
        // wait: output to a pipe is written asynchronously on Linux, and a script reading it would get it cut off.
        process.exitCode = printedErrors() > 0 ? 1 : 0;
        return;
    }

    const rule = '='.repeat(70);
    printLine('');
    printLine('Streembit CLI');
    printLine(rule);
    printLine(`Data directory: ${DataDir()}`);
    printLine(`Read API:       ${await readMirrorStatus()}`);
    printLine(`Node:           ${NodeUrl()} (transaction submission and multisig requests)`);
    printLine(rule);
    printLine("Type 'help' for available commands. Press Ctrl+C or type 'exit' to quit.");
    printLine(rule);

    await startRepl('streembit> ');
}

// An interrupt signal from outside, or Ctrl+C while no prompt has the keyboard: the command that was running is
// abandoned, so the run ends as interrupted, never as a success. Nothing is printed: a script's output stays clean.
process.on('SIGINT', () => {
    process.exit(EXIT_INTERRUPTED);
});

main().catch((error: unknown) => {
    console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
