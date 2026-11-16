/**
 * Multisig commands
 *
 * A contract call that needs several signatures is parked at the Accountable Node, which collects the signatures
 * and submits the transaction when the threshold is reached. The requests waiting for signatures are kept by the
 * node alone, not on the chain, so these commands read and write them at the node (NODE_URL) through the SDK's
 * client; the chain status, the sequence and the contract metadata of a new request are read from the mirror, as
 * for every transaction.
 *
 *   multisig-request    build an unsigned contract call, sign it as its sender and park it
 *   multisig-pending    list the requests in which the key is an authorised signer
 *   multisig-show       show one request with the decoded parameters and the signers
 *   multisig-sign       sign a request and upload the signature
 *   multisig-tx-submit  retry the submission when the automatic one after the last signature failed
 *   multisig-watch      poll every 30 seconds and print new requests, new signatures and status changes
 *
 * The key is a wallet address (--from, account 0 address 0 when left out) or --key-env <NAME>, an environment
 * variable that holds a private key in hex: a key that is in no wallet, such as the second registered key of an
 * Accountable Node. A transaction carries at most 3 signatures in Phase 1.
 */

import { CommandDef, shellRunning } from '../cli/shell';
import { validateAddress, isContractAddress, buildContractCallTx, getTxSignatures, pendingTxId, SoftwareSigner, decodeDeterministicJSON, hexToBytes } from 'streembit-bc-sdk';
import { fetchStatus, fetchAccount, fetchContract, createMultisigRequest, fetchMultisigRequests, fetchMultisigRequest, sendMultisigSignature, submitMultisigRequest } from 'streembit-bc-sdk/api';
import { AssetId, SBRIT_FEE_AMOUNT, ContractLocation } from 'streembit-bc-types';
import type { PendingMultisigTx, PendingMultisigStatus, MultisigSubmission } from 'streembit-bc-types';
import Decimal from 'decimal.js';
import { parseArgs } from '../cli/args';
import { hasTerminal, promptConfirm } from '../cli/input';
import { printLine, printNote, printError } from '../cli/output';
import { openWallet, describeApiError, readCallData } from './wallet';

const KEY_OPTIONS = '[--from <address> | --key-env <NAME>]';
const MULTISIG_STATUSES: readonly string[] = ['pending', 'submitted', 'expired', 'stale'] satisfies PendingMultisigStatus[];
const RECORD_ID_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * The signer of a multisig command: the key in the environment variable --key-env names, or the key of a wallet
 * address, --from or account 0 address 0. The caller disposes it when the command is done.
 * @returns The signer, or null after the error is printed
 */
async function multisigSigner(options: Map<string, string>): Promise<SoftwareSigner | null> {
    const keyEnv = options.get('key-env');
    const from = options.get('from');
    if (keyEnv !== undefined && from !== undefined) {
        printError('Give --from or --key-env, not both');
        return null;
    }
    if (keyEnv !== undefined) {
        // An option given without a value is read as 'true': --key-env needs the name of the variable
        if (keyEnv === 'true') {
            printError('--key-env needs the name of the environment variable that holds the private key');
            return null;
        }
        const privateKey = process.env[keyEnv];
        if (!privateKey) {
            printError(`Environment variable ${keyEnv} is not set`);
            return null;
        }
        if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) {
            printError(`Environment variable ${keyEnv} must hold a private key of 64 hex characters`);
            return null;
        }
        return new SoftwareSigner(privateKey.toLowerCase());
    }

    if (from !== undefined && !validateAddress(from)) {
        printError(`Invalid from address: ${from}`);
        return null;
    }
    const wallet = await openWallet();
    if (!wallet) return null;
    const address = from ?? wallet.getAccount(0, 0).address;
    const account = await wallet.getAccountByAddress(address);
    if (!account) {
        printError(`Address ${address} is not in this wallet. Use wallet-addresses to list the wallet addresses.`);
        return null;
    }
    return new SoftwareSigner(account.privateKey);
}

/** The --id option of a command: the id of a request, 64 hex characters; null after the error is printed */
function recordIdOption(options: Map<string, string>, usage: string): string | null {
    const id = options.get('id');
    if (!id || id === 'true') {
        printError(`Usage: ${usage}`);
        return null;
    }
    if (!RECORD_ID_PATTERN.test(id)) {
        printError(`Invalid request id: ${id}`);
        return null;
    }
    return id.toLowerCase();
}

/** The parameters of the call as text for the signers to read: indented JSON, (none) for a call without data, the hex itself when it does not hold JSON */
function decodeCallData(dataHex: string): string {
    if (dataHex === '') return '(none)';
    try {
        return JSON.stringify(decodeDeterministicJSON(hexToBytes(dataHex)), null, 2);
    } catch {
        return dataHex;
    }
}

/** Print a request: the short form of a list, or the full view with the decoded parameters and each signer */
function printMultisigRecord(record: PendingMultisigTx, full: boolean): void {
    printLine(`Id:         ${record.id}`);
    printLine(`Status:     ${record.status}${record.submittedTxId ? ` (tx ${record.submittedTxId})` : ''}`);
    printLine(`Contract:   ${record.contract}`);
    printLine(`Method:     ${record.method}`);
    printLine(`Sender:     ${record.unsignedTx.from} (sequence ${record.unsignedTx.sequence})`);
    printLine(`Signatures: ${record.signatures.length} of ${record.thresholdM}`);
    printLine(`Expires:    ${new Date(record.expiresAt).toISOString()}`);
    if (full) {
        printLine(`Parameters: ${decodeCallData(record.unsignedTx.data)}`);
        printLine('Authorised signers:');
        for (const signer of record.authorizedSigners) {
            const signed = record.signatures.find(s => s.publickey === signer);
            printLine(`  ${signer} ${signed ? `signed at ${new Date(signed.receivedAt).toISOString()}` : 'not signed'}`);
        }
    }
}

/** Print what the node did when the threshold was reached: submitted is the answer, stale and failed are errors */
function printSubmission(submission: MultisigSubmission): void {
    if (submission.status === 'submitted') {
        printLine(`Threshold reached, transaction submitted: ${submission.txId ?? ''}`);
        if (submission.response) {
            printLine(submission.response);
        }
    } else if (submission.status === 'stale') {
        printError(`Not submitted, the request is stale: ${submission.reason ?? 'request again with multisig-request'}`);
    } else {
        printError(`Threshold reached but the submission failed, retry with multisig-tx-submit --id <id>: ${submission.reason ?? 'unknown error'}`);
    }
}

const REQUEST_USAGE = `multisig-request --contract <address> --method <name> --data <json|file> ${KEY_OPTIONS} [--yes]`;

/**
 * multisig-request: build an unsigned contract call from the key's address, sign it as its sender and park it at
 * the node. The node parks nothing without the sender's signature, so the request is signed at once. With --yes
 * there is no review and no confirmation and the answer is the request id alone.
 */
export const multisigRequestCmd: CommandDef = {
    name: 'multisig-request',
    summary: 'Park a contract call that needs several signatures, signed as its sender',
    usage: REQUEST_USAGE,
    handler: async (args: string[]) => {
        let signer: SoftwareSigner | null = null;
        try {
            const yes = args.includes('--yes');
            const { options } = parseArgs(args.filter(arg => arg !== '--yes'));
            const contract = options.get('contract');
            const method = options.get('method');
            const dataInput = options.get('data');
            if (!contract || !method || method === 'true' || dataInput === undefined) {
                printError(`Usage: ${REQUEST_USAGE}`);
                return;
            }
            if (!validateAddress(contract) || !isContractAddress(contract)) {
                printError(`Invalid contract address: ${contract}`);
                return;
            }
            const data = readCallData(dataInput);
            if (!data) return;

            signer = await multisigSigner(options);
            if (!signer) return;
            const from = signer.address;

            const chain = await fetchStatus();
            const info = await fetchAccount(from);
            const meta = await fetchContract(contract);
            if (!(Object.values(ContractLocation) as string[]).includes(meta.location)) {
                printError(`Unknown contract location "${meta.location}" for contract ${contract}`);
                return;
            }
            if (new Decimal(info.balance).lt(SBRIT_FEE_AMOUNT)) {
                printError(`Balance ${info.balance} ${AssetId.SBRIT} of ${from} is below the fee of ${SBRIT_FEE_AMOUNT} ${AssetId.SBRIT}`);
                return;
            }

            if (!yes) {
                printLine('\nMultisig request review:');
                printLine('='.repeat(60));
                printLine(`From:       ${from}`);
                printLine(`Signer key: ${signer.publicKey}`);
                printLine(`Contract:   ${contract}`);
                printLine(`Method:     ${method}`);
                printLine(`Data:       ${JSON.stringify(data)}`);
                printLine(`Fee:        ${SBRIT_FEE_AMOUNT} ${AssetId.SBRIT}`);
                printLine(`Sequence:   ${info.sequence + 1}`);
                printLine(`Network:    ${chain.network}, chain ${chain.chainId}`);
                printLine('='.repeat(60));
                if (!hasTerminal()) {
                    printError('No terminal to confirm the request on. Add --yes to send without the confirmation.');
                    return;
                }
                if (!await promptConfirm('Sign and park this request?')) {
                    printLine('Request cancelled');
                    return;
                }
            }

            const unsignedTx = buildContractCallTx({ chainId: chain.chainId, version: chain.version, from, to: contract, method, data, codeHash: meta.codeHash, sandboxHash: meta.sandboxHash, location: meta.location as ContractLocation, amount: '0', sequence: info.sequence + 1 });
            const [signature] = await getTxSignatures(unsignedTx, [signer]);
            const answer = await createMultisigRequest(unsignedTx, signature);

            if (yes) {
                // The request id alone, for a script. A request that was complete with the sender's signature was submitted at
                // once: a submitted transaction is noted beside the id, a stale or failed submission is an error
                printLine(answer.record.id);
                if (answer.submission?.status === 'submitted') {
                    printNote(`Threshold reached, transaction submitted: ${answer.submission.txId ?? ''}`);
                } else if (answer.submission) {
                    printSubmission(answer.submission);
                }
                return;
            }
            printLine('\nRequest parked. Give the id to the other signers.');
            printMultisigRecord(answer.record, false);
            if (answer.submission) {
                printLine('');
                printSubmission(answer.submission);
            }
        } catch (error) {
            printError(`multisig-request failed: ${describeApiError(error)}`);
        } finally {
            signer?.dispose();
        }
    }
};

const PENDING_USAGE = `multisig-pending [--status pending|submitted|expired|stale] ${KEY_OPTIONS}`;

/** multisig-pending: the requests in which the key is an authorised signer, in short form; the pending ones unless --status names another status */
export const multisigPendingCmd: CommandDef = {
    name: 'multisig-pending',
    summary: 'List the multisig requests in which the key is an authorised signer',
    usage: PENDING_USAGE,
    handler: async (args: string[]) => {
        let signer: SoftwareSigner | null = null;
        try {
            const { options } = parseArgs(args);
            const status = options.get('status') ?? 'pending';
            if (!MULTISIG_STATUSES.includes(status)) {
                printError(`Usage: ${PENDING_USAGE}`);
                return;
            }
            signer = await multisigSigner(options);
            if (!signer) return;

            const records = await fetchMultisigRequests(signer.publicKey, status as PendingMultisigStatus);
            if (records.length === 0) {
                printLine(`No ${status} multisig requests for the key ${signer.publicKey}`);
                return;
            }
            printLine(`${records.length} ${status} multisig request(s) for the key ${signer.publicKey}:`);
            for (const record of records) {
                printLine('');
                printMultisigRecord(record, false);
            }
        } catch (error) {
            printError(`multisig-pending failed: ${describeApiError(error)}`);
        } finally {
            signer?.dispose();
        }
    }
};

const SHOW_USAGE = 'multisig-show --id <id>';

/** multisig-show: one request in full, with the decoded parameters and each signer with whether and when it signed */
export const multisigShowCmd: CommandDef = {
    name: 'multisig-show',
    summary: 'Show one multisig request with the decoded parameters and the signers',
    usage: SHOW_USAGE,
    handler: async (args: string[]) => {
        try {
            const { options } = parseArgs(args);
            const id = recordIdOption(options, SHOW_USAGE);
            if (!id) return;
            printMultisigRecord(await fetchMultisigRequest(id), true);
        } catch (error) {
            printError(`multisig-show failed: ${describeApiError(error)}`);
        }
    }
};

const SIGN_USAGE = `multisig-sign --id <id> ${KEY_OPTIONS} [--yes]`;

/**
 * multisig-sign: fetch the request, show it in full, sign its unsigned transaction with the key and upload the
 * signature. The id of a request is the hash of the bytes the signers sign: a request whose transaction does not
 * hash to its id is refused, so what is signed is what was asked for by that id. With --yes there is no confirmation.
 */
export const multisigSignCmd: CommandDef = {
    name: 'multisig-sign',
    summary: 'Sign a multisig request and upload the signature',
    usage: SIGN_USAGE,
    handler: async (args: string[]) => {
        let signer: SoftwareSigner | null = null;
        try {
            const yes = args.includes('--yes');
            const { options } = parseArgs(args.filter(arg => arg !== '--yes'));
            const id = recordIdOption(options, SIGN_USAGE);
            if (!id) return;
            signer = await multisigSigner(options);
            if (!signer) return;
            const publicKey = signer.publicKey;

            const record = await fetchMultisigRequest(id);
            printMultisigRecord(record, true);
            printLine(`Signing key: ${publicKey}`);

            if (record.id !== id || pendingTxId(record.unsignedTx) !== id) {
                printError(`The node answered a request whose transaction does not match the id ${id}: not signed`);
                return;
            }
            if (record.status !== 'pending') {
                printError(`The request is ${record.status}: signatures are no longer accepted`);
                return;
            }
            if (!record.authorizedSigners.includes(publicKey)) {
                printError(`The key ${publicKey} is not an authorised signer of this request`);
                return;
            }
            if (record.signatures.some(s => s.publickey === publicKey)) {
                printError(`The key ${publicKey} has already signed this request`);
                return;
            }

            if (!yes) {
                if (!hasTerminal()) {
                    printError('No terminal to confirm the signature on. Add --yes to sign without the confirmation.');
                    return;
                }
                if (!await promptConfirm('Sign this request?')) {
                    printLine('Signature cancelled');
                    return;
                }
            }

            const [signature] = await getTxSignatures(record.unsignedTx, [signer]);
            const answer = await sendMultisigSignature(id, signature);
            printLine(`\nSignature uploaded: ${answer.record.signatures.length} of ${answer.record.thresholdM} collected`);
            if (answer.submission) {
                printSubmission(answer.submission);
            }
        } catch (error) {
            printError(`multisig-sign failed: ${describeApiError(error)}`);
        } finally {
            signer?.dispose();
        }
    }
};

const SUBMIT_USAGE = 'multisig-tx-submit --id <id>';

/** multisig-tx-submit: ask the node to submit again a request that holds its signatures and whose automatic submission failed */
export const multisigTxSubmitCmd: CommandDef = {
    name: 'multisig-tx-submit',
    summary: 'Retry the submission of a fully signed multisig request whose automatic submission failed',
    usage: SUBMIT_USAGE,
    handler: async (args: string[]) => {
        try {
            const { options } = parseArgs(args);
            const id = recordIdOption(options, SUBMIT_USAGE);
            if (!id) return;
            const answer = await submitMultisigRequest(id);
            printMultisigRecord(answer.record, false);
            printLine('');
            printSubmission(answer.submission);
        } catch (error) {
            printError(`multisig-tx-submit failed: ${describeApiError(error)}`);
        }
    }
};

// ============= multisig-watch =============

const MULTISIG_WATCH_INTERVAL_MS = 30_000;

/** What the watch last saw of a request */
interface WatchedRequest {
    status: PendingMultisigStatus;
    signatures: number;
}

let watchTimer: NodeJS.Timeout | null = null;
let watchKey = '';
let watchLastError = '';
const watchKnown = new Map<string, WatchedRequest>();

/** One line per change between what the watch last saw and the node's requests now: a new pending request, a new signature, a new status */
function watchChanges(records: PendingMultisigTx[]): string[] {
    const lines: string[] = [];
    for (const record of records) {
        const seen = watchKnown.get(record.id);
        const current: WatchedRequest = { status: record.status, signatures: record.signatures.length };
        if (!seen) {
            if (record.status === 'pending') {
                lines.push(`New request ${record.id}: ${record.method} at ${record.contract} from ${record.unsignedTx.from}, ${current.signatures} of ${record.thresholdM} signed, expires ${new Date(record.expiresAt).toISOString()}`);
            }
        } else {
            if (current.signatures !== seen.signatures && record.status === 'pending') {
                lines.push(`Request ${record.id}: ${current.signatures} of ${record.thresholdM} signed`);
            }
            if (current.status !== seen.status) {
                lines.push(`Request ${record.id} is now ${record.status}${record.submittedTxId ? ` (tx ${record.submittedTxId})` : ''}`);
            }
        }
        watchKnown.set(record.id, current);
    }
    return lines;
}

async function watchTick(): Promise<void> {
    try {
        const records = await fetchMultisigRequests(watchKey);
        watchLastError = '';
        for (const line of watchChanges(records)) {
            printLine(`[multisig-watch] ${line}`);
        }
    } catch (error) {
        // A failure is reported once, not every 30 seconds while it lasts
        const message = describeApiError(error);
        if (message !== watchLastError) {
            watchLastError = message;
            printError(`[multisig-watch] ${message}`);
        }
    }
}

function stopWatch(): void {
    if (watchTimer) {
        clearInterval(watchTimer);
        watchTimer = null;
    }
    watchKnown.clear();
    watchLastError = '';
}

const WATCH_USAGE = `multisig-watch [--stop] ${KEY_OPTIONS}`;

/**
 * multisig-watch: poll the requests of the key every 30 seconds and print new requests, new signatures and status
 * changes. In the shell it runs in the background until multisig-watch --stop; run as a single command it runs
 * until Ctrl+C. Only the public key is kept for the polling, the signer is disposed at once.
 */
export const multisigWatchCmd: CommandDef = {
    name: 'multisig-watch',
    summary: 'Poll every 30 seconds and print new multisig requests, new signatures and status changes',
    usage: WATCH_USAGE,
    handler: async (args: string[]) => {
        try {
            const stop = args.includes('--stop');
            const { options } = parseArgs(args.filter(arg => arg !== '--stop'));
            if (stop) {
                const wasRunning = watchTimer !== null;
                stopWatch();
                printLine(wasRunning ? 'multisig-watch stopped' : 'multisig-watch is not running');
                return;
            }

            const signer = await multisigSigner(options);
            if (!signer) return;
            const publicKey = signer.publicKey;
            signer.dispose();

            stopWatch();
            watchKey = publicKey;

            // The first poll reports the pending requests, the later ones the changes
            await watchTick();
            watchTimer = setInterval(() => { void watchTick(); }, MULTISIG_WATCH_INTERVAL_MS);

            if (shellRunning()) {
                // In the shell the watch must not keep the process alive after exit
                watchTimer.unref();
                printLine(`multisig-watch started for the key ${publicKey}: polling every ${MULTISIG_WATCH_INTERVAL_MS / 1000} seconds (multisig-watch --stop to end)`);
                return;
            }
            printNote(`multisig-watch started for the key ${publicKey}: polling every ${MULTISIG_WATCH_INTERVAL_MS / 1000} seconds, Ctrl+C to end`);
            // One-shot mode: the command does not end by itself, Ctrl+C ends the process
            await new Promise<never>(() => undefined);
        } catch (error) {
            printError(`multisig-watch failed: ${describeApiError(error)}`);
        }
    }
};

export const multisigCommands: CommandDef[] = [
    multisigRequestCmd,
    multisigPendingCmd,
    multisigShowCmd,
    multisigSignCmd,
    multisigTxSubmitCmd,
    multisigWatchCmd
];
