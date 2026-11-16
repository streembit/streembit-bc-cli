/**
 * Wallet commands
 *
 * The wallet file and the keys are local; everything about the chain is read from the read mirror's
 * public HTTP API through the SDK's client (READ_URL). Sending builds and signs the transfer here with
 * the SDK and submits it to the Accountable Node (NODE_URL), the only request the node receives; it
 * attests the transfer and puts it in the mempool. Command names follow the Bitcoin CLI where one exists.
 */

import { CommandDef } from '../cli/shell';
import { HDWallet } from '../wallet';
import { NetworkKnown, setNetwork } from '../config';
import { validatePassword, validateAddress, isContractAddress, validateAmount, buildTransferTx, buildContractCallTx, signTransaction, SoftwareSigner, txToString } from 'streembit-bc-sdk';
import type { TransferParams, ContractCallParams } from 'streembit-bc-sdk';
import { apiBaseUrl, readApiBaseUrl, fetchStatus, fetchAccount, fetchTransactions, fetchWalletTransactions, fetchTransaction, fetchContract, fetchCell, submitWithSequenceRetry, ApiError } from 'streembit-bc-sdk/api';
import type { TransactionRecord, WalletTransactionRecord } from 'streembit-bc-sdk/api';
import { AssetId, SBRIT_FEE_AMOUNT, ContractLocation, NSkey } from 'streembit-bc-types';
import type { Transaction } from 'streembit-bc-types';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Decimal from 'decimal.js';
import { parseArgs } from '../cli/args';
import { hasTerminal, hasScreen, promptText, promptPassword, promptPasswordWithRequirements, promptConfirm } from '../cli/input';
import { printLine, printNote, printError, toErrorMessage } from '../cli/output';

/** The error answer of the mirror or the node as the user should read it: the message, with the code for reference. */
export function describeApiError(error: unknown): string {
    if (error instanceof ApiError) {
        return error.code ? `${error.message} [${error.code}]` : error.message;
    }
    return toErrorMessage(error);
}

/**
 * The wallet password: WALLET_PASSWORD when it is set, so that a script or a service runs without a prompt,
 * otherwise typed at the terminal. A wrong WALLET_PASSWORD fails the command; it never falls back to the prompt.
 */
async function walletPassword(): Promise<string> {
    const configured = process.env.WALLET_PASSWORD;
    if (configured) {
        return configured;
    }
    if (!hasTerminal()) {
        throw new Error('No terminal to type the wallet password on. Set WALLET_PASSWORD to run without one.');
    }
    return promptPassword('Enter wallet password: ');
}

/** Unlock the wallet kept in the data directory, with the password from WALLET_PASSWORD or the prompt when the session is not open. */
export async function openWallet(): Promise<HDWallet | null> {
    if (!await HDWallet.exists()) {
        printError('No wallet found. Use wallet-create or wallet-restore first.');
        return null;
    }
    if (!HDWallet.isAuthenticated()) {
        await HDWallet.initialize(await walletPassword());
    }
    return HDWallet.getInstance();
}

/**
 * Before a command puts another wallet in the place of the existing one: the word yes is typed in full, a single
 * key is not enough for a file that holds a recovery phrase. The existing file is not lost either way, a copy
 * of it is kept beside the new one.
 * @returns True when there is no wallet file yet or the replacement was confirmed
 */
async function confirmReplaceWallet(): Promise<boolean> {
    if (!await HDWallet.exists()) {
        return true;
    }
    const answer = await promptText('A wallet already exists. It will be replaced; a copy of the existing file is kept beside it. Type yes to continue: ');
    return answer.trim().toLowerCase() === 'yes';
}

/**
 * A wallet file records the network it belongs to, and the name comes from the read mirror alone. Before a wallet
 * is created or restored the mirror is asked, unless it has answered already; while it does not answer no wallet
 * is created, because the file would carry a guessed network.
 * @returns True when the network is known; false after the error was printed
 */
async function learnNetwork(command: string): Promise<boolean> {
    if (NetworkKnown()) {
        return true;
    }
    try {
        setNetwork((await fetchStatus()).network);
        return true;
    } catch (error) {
        printError(`${command} needs the read mirror: a wallet file records its network, and the mirror at ${readApiBaseUrl()} did not give it (${describeApiError(error)}). No wallet was created.`);
        return false;
    }
}

/** Tell where the copy of the replaced wallet file is */
function printReplacedCopy(replaced: string | null): void {
    if (replaced) {
        printLine(`The previous wallet file was kept as ${replaced}`);
    }
}

/**
 * Create new wallet
 */
export const walletCreateCmd: CommandDef = {
    name: 'wallet-create',
    summary: 'Create a new HD wallet',
    usage: 'wallet-create',
    handler: async () => {
        try {
            if (!hasTerminal()) {
                printError('wallet-create needs a terminal: the recovery phrase is shown and the password is typed there.');
                return;
            }
            if (!hasScreen()) {
                printError('wallet-create shows the recovery phrase on the terminal only: its output cannot go to a file or a pipe.');
                return;
            }
            if (!await learnNetwork('wallet-create')) {
                return;
            }
            if (!await confirmReplaceWallet()) {
                printLine('Wallet creation cancelled');
                return;
            }
            HDWallet.clearSession();

            const password = await promptPasswordWithRequirements();

            printLine('Creating new wallet...');
            const wallet = await HDWallet.createNew(password);
            printReplacedCopy(await wallet.saveToFile(password));

            printLine('\n' + '='.repeat(60));
            printLine('IMPORTANT: Write down these words in order!');
            printLine('This is your wallet recovery phrase.');
            printLine('Keep it secret and safe!');
            printLine('='.repeat(60));
            printLine('\nMnemonic phrase:');
            printLine(wallet.getMnemonic());
            printLine('\n' + '='.repeat(60));

            const account = wallet.getAccount(0, 0);
            printLine('\nWallet created successfully!');
            printLine(`Your first address: ${account.address}`);

        } catch (error) {
            printError(`Failed to create wallet: ${toErrorMessage(error)}`);
        }
    }
};

/**
 * Restore wallet from mnemonic
 */
export const walletRestoreCmd: CommandDef = {
    name: 'wallet-restore',
    summary: 'Restore wallet from mnemonic phrase',
    usage: 'wallet-restore',
    handler: async () => {
        try {
            if (!hasTerminal()) {
                printError('wallet-restore needs a terminal: the recovery phrase and the password are typed there.');
                return;
            }
            if (!await learnNetwork('wallet-restore')) {
                return;
            }
            if (!await confirmReplaceWallet()) {
                printLine('Wallet restoration cancelled');
                return;
            }

            const mnemonic = await promptText('Enter your mnemonic phrase: ');
            if (!mnemonic || mnemonic.split(' ').length < 12) {
                printError('Invalid mnemonic phrase');
                return;
            }

            printLine('\nPassword requirements:');
            printLine('  - Minimum 12 characters');
            printLine('  - At least one lowercase letter (a-z)');
            printLine('  - At least one uppercase letter (A-Z)');
            printLine('  - At least one number (0-9)');
            printLine('  - At least one special character (!@#$%^&*() etc.)\n');

            let password: string = '';
            let passwordValid = false;

            while (!passwordValid) {
                password = await promptPassword('Enter password for wallet: ');
                const validation = validatePassword(password);

                if (!validation.isValid) {
                    printError(validation.error || 'Invalid password');
                    printLine('Please try again.\n');
                    continue;
                }

                const confirmPassword = await promptPassword('Confirm password: ');
                if (password !== confirmPassword) {
                    printError('Passwords do not match');
                    printLine('Please try again.\n');
                    continue;
                }

                passwordValid = true;
            }

            HDWallet.clearSession();

            printLine('Restoring wallet...');
            const wallet = await HDWallet.createNew(password, mnemonic);
            printReplacedCopy(await wallet.saveToFile(password));

            const account = wallet.getAccount(0, 0);
            printLine('Wallet restored successfully!');
            printLine(`Your first address: ${account.address}`);

        } catch (error) {
            printError(`Failed to restore wallet: ${toErrorMessage(error)}`);
        }
    }
};

/**
 * Show wallet addresses
 */
export const walletShowCmd: CommandDef = {
    name: 'wallet-show',
    summary: 'Show wallet addresses',
    usage: 'wallet-show [account_index] [address_count]',
    handler: async (args: string[]) => {
        try {
            const wallet = await openWallet();
            if (!wallet) return;

            const accountIndex = parseInt(args[0] || '0');
            const addressCount = parseInt(args[1] || '5');

            printLine('\nWallet Addresses:');
            printLine('='.repeat(80));
            printLine(`Account ${accountIndex}:`);

            for (let i = 0; i < addressCount; i++) {
                const account = wallet.getAccount(accountIndex, i);
                printLine(`[${i}] Address: ${account.address}`);
                printLine(`    Path: ${account.path}`);
            }

            printLine('='.repeat(80));

        } catch (error) {
            printError(`Failed to show addresses: ${toErrorMessage(error)}`);
        }
    }
};

/**
 * Check the SBRIT balance and the sequence of a wallet address through the read mirror
 */
export const walletBalanceCmd: CommandDef = {
    name: 'wallet-balance',
    summary: 'Check wallet balance',
    usage: 'wallet-balance [account_index] [address_index]',
    handler: async (args: string[]) => {
        try {
            const wallet = await openWallet();
            if (!wallet) return;

            const accountIndex = parseInt(args[0] || '0');
            const addressIndex = parseInt(args[1] || '0');

            const info = await wallet.getAccountInfo(accountIndex, addressIndex);

            printLine(`\nAddress:  ${info.address}`);
            printLine(`Balance:  ${info.balance} ${AssetId.SBRIT}`);
            printLine(`Sequence: ${info.sequence}`);

        } catch (error) {
            printError(`Failed to check balance: ${describeApiError(error)}`);
        }
    }
};

/**
 * List tracked wallet addresses
 */
export const walletAddressesCmd: CommandDef = {
    name: 'wallet-addresses',
    summary: 'List tracked wallet addresses',
    usage: 'wallet-addresses',
    handler: async () => {
        try {
            const wallet = await openWallet();
            if (!wallet) return;

            const addresses = await wallet.listKnownAddresses();

            if (addresses.length === 0) {
                printLine('No addresses have been generated yet.');
                return;
            }

            printLine('\nTracked Addresses:');
            printLine('='.repeat(100));
            printLine('Acct  Idx  Address                                    Label               Path');
            printLine('-'.repeat(100));

            for (const entry of addresses) {
                const labelText = entry.label ?? '-';
                printLine(`${entry.accountIndex.toString().padStart(4)}  ${entry.addressIndex.toString().padStart(3)}  ${entry.address.padEnd(42)}  ${labelText.padEnd(18)}  ${entry.path}`);
            }

            printLine('='.repeat(100));
        } catch (error) {
            printError(`Failed to list addresses: ${toErrorMessage(error)}`);
        }
    }
};

/**
 * Generate new address
 */
export const walletNewAddressCmd: CommandDef = {
    name: 'wallet-new-address',
    summary: 'Generate a new address in your wallet',
    usage: 'wallet-new-address [account_index] [--label <label>]',
    handler: async (args: string[]) => {
        try {
            const { positional, options } = parseArgs(args);
            const accountIndex = positional.length > 0 ? parseInt(positional[0]) || 0 : 0;
            const label = options.has('label') && options.get('label') !== 'true' ? options.get('label') : undefined;

            const wallet = await openWallet();
            if (!wallet) return;

            printLine('Generating new address...');
            const result = await wallet.getNextAddress(accountIndex, label);

            printLine('\n' + '='.repeat(60));
            printLine('New address generated successfully!');
            printLine('='.repeat(60));
            printLine(`Address:  ${result.address}`);
            printLine(`Index:    ${result.index}`);
            printLine(`Path:     ${result.path}`);
            printLine(`Account:  ${result.accountIndex}`);
            if (result.label) {
                printLine(`Label:    ${result.label}`);
            }
            printLine('='.repeat(60));

        } catch (error) {
            printError(`Failed to generate new address: ${toErrorMessage(error)}`);
        }
    }
};

/**
 * Sign the transaction with the sender's key and return the JSON the node receives; the signer is disposed with the call.
 * The submission, and the second one with the sequence the node names when the mirror was behind, is the SDK's
 * submitWithSequenceRetry: it calls this for each sequence it submits.
 */
async function signedJson(tx: Transaction, privateKey: string): Promise<string> {
    const signer = new SoftwareSigner(privateKey);
    try {
        await signTransaction(tx, [signer]);
    } finally {
        signer.dispose();
    }
    return txToString(tx);
}

/**
 * Send SBRIT from a wallet address, in two forms told apart by the number of arguments:
 *   sendtoaddress <to> <amount> [SBRIT] [--from <address>]   the Bitcoin CLI's form, as the specification writes it;
 *                                                            the sender is account 0, address 0 unless --from names another
 *   sendtoaddress <from> <to> <asset> <amount>               the node CLI's form
 * The sender must be an address of this wallet; its key is derived for the signature and disposed with the
 * signer. The chain status, the balance and the sequence are read from the mirror; the node receives the
 * signed transaction only. A mirror that is a block behind gives a sequence the node refuses with the one it
 * expects: the transfer is then signed again with that sequence and submitted once more.
 * With --yes there is no review and no confirmation and the answer is the transaction id alone, as the
 * Bitcoin CLI prints it; without it the review is shown and confirmed at the terminal.
 */
const SEND_USAGE = 'sendtoaddress <to> <amount> [SBRIT] [--from <address>] [--yes]  or  sendtoaddress <from> <to> <asset> <amount> [--yes]';

export const sendToAddressCmd: CommandDef = {
    name: 'sendtoaddress',
    summary: 'Send money to an address.',
    usage: SEND_USAGE,
    handler: async (args: string[]) => {
        try {
            // --yes sends without the confirmation, for a script; taken out first so that it never takes the next argument as its value
            const yes = args.includes('--yes');
            const { positional, options } = parseArgs(args.filter(arg => arg !== '--yes'));
            if (positional.length < 2) {
                printError(`Usage: ${SEND_USAGE}`);
                return;
            }
            const fourArguments = positional.length >= 4;
            if (fourArguments && options.has('from')) {
                printError('--from cannot be used with the form that already names the sender: sendtoaddress <from> <to> <asset> <amount>');
                return;
            }
            // The sender of the short form is resolved after the wallet is open, when --from does not name it
            let from = fourArguments ? positional[0] : options.get('from');
            const to = fourArguments ? positional[1] : positional[0];
            const asset = (fourArguments ? positional[2] : positional[2] ?? AssetId.SBRIT).toUpperCase();
            const amount = fourArguments ? positional[3] : positional[1];

            if (from !== undefined && !validateAddress(from)) {
                printError(`Invalid from address: ${from}`);
                return;
            }
            if (!validateAddress(to)) {
                printError(`Invalid to address: ${to}`);
                return;
            }
            if (asset !== AssetId.SBRIT) {
                printError(`Asset must be ${AssetId.SBRIT}`);
                return;
            }
            if (!validateAmount(amount)) {
                printError('Amount must be a positive number with up to 8 decimal places');
                return;
            }

            const wallet = await openWallet();
            if (!wallet) return;

            if (from === undefined) {
                from = wallet.getAccount(0, 0).address;
            }
            const sender = await wallet.getAccountByAddress(from);
            if (!sender) {
                printError(`Address ${from} is not in this wallet. Use wallet-addresses to list the wallet addresses.`);
                return;
            }

            // From the read mirror: the Accountable Node answers no lookups, it receives the signed transaction only
            const chain = await fetchStatus();
            const info = await fetchAccount(from);
            const required = new Decimal(amount).plus(SBRIT_FEE_AMOUNT).toString();
            if (new Decimal(info.balance).lt(required)) {
                printError(`Balance ${info.balance} ${AssetId.SBRIT} is below the amount plus fee of ${required} ${AssetId.SBRIT}`);
                return;
            }

            if (!yes) {
                printLine('\nTransaction review:');
                printLine('='.repeat(60));
                printLine(`From:     ${from}`);
                printLine(`To:       ${to}`);
                printLine(`Amount:   ${amount} ${AssetId.SBRIT}`);
                printLine(`Fee:      ${SBRIT_FEE_AMOUNT} ${AssetId.SBRIT}`);
                printLine(`Sequence: ${info.sequence + 1}`);
                printLine(`Network:  ${chain.network}, chain ${chain.chainId}`);
                printLine('='.repeat(60));
                if (!hasTerminal()) {
                    printError('No terminal to confirm the transaction on. Add --yes to send without the confirmation.');
                    return;
                }
                if (!await promptConfirm('Sign and send this transaction?')) {
                    printLine('Transaction cancelled');
                    return;
                }
            }

            const transfer: TransferParams = { chainId: chain.chainId, version: chain.version, from, to, amount, asset: AssetId.SBRIT, sequence: info.sequence + 1 };
            const senderKey = sender.privateKey;
            const result = await submitWithSequenceRetry(transfer.sequence, sequence => signedJson(buildTransferTx({ ...transfer, sequence }), senderKey));
            if (result.resubmitted) {
                printNote(`The read mirror was behind the node: sent again with sequence ${result.sequence}`);
            }
            if (yes) {
                // The Bitcoin CLI's answer: the transaction id alone; a transaction the node is still processing is noted beside it
                if (result.status === 'pending') {
                    printNote('Transaction accepted, still being processed by the node');
                }
                printLine(result.txid);
                return;
            }
            printLine(`\nTransaction ${result.status === 'pending' ? 'accepted, still being processed by the node' : 'included in a block'}`);
            printLine(`Transaction ID: ${result.txid}`);

        } catch (error) {
            printError(`Failed to send: ${describeApiError(error)}`);
        }
    }
};

export function formatTransactionRow(tx: TransactionRecord, own: string): string {
    const sent = tx.from === own;
    const direction = tx.method ? `call ${tx.method}` : sent ? 'sent' : 'received';
    const counterparty = sent ? tx.to : tx.from;
    const time = tx.timestamp ? new Date(tx.timestamp).toISOString().replace('T', ' ').slice(0, 19) : '';
    return `${time.padEnd(19)}  ${direction.padEnd(14)} ${counterparty.padEnd(36)} ${tx.amount.padStart(14)}  ${tx.txid}`;
}

/** One entry of listtransactions, with the Bitcoin CLI's field names: one thing a transaction did to one address of the wallet */
interface WalletTransactionEntry {
    address: string;
    category: 'send' | 'receive';
    amount: string;
    label?: string;
    fee?: string;
    blockheight: number;
    blockindex: number;
    time: number;
    txid: string;
    type: string;
    method?: string;
}

/**
 * The entries of one transaction of the wallet's history: one per balance change the mirror reports for a wallet
 * address, as the chain's state diff recorded it. The sender's change holds the amount and the fee, so the fee is
 * taken out of the amount and shown beside it, as the Bitcoin CLI does; every other change is the amount itself.
 * The sign of the amount decides the category: negative is a send, positive a receive, and zero is a send only for
 * the sender's own change. A send names the destination, a receive the wallet address that received.
 * @param record One transaction of the mirror's answer, with its balance changes
 * @param labels The labels of the wallet's addresses, by address
 */
function walletTransactionEntries(record: WalletTransactionRecord, labels: Map<string, string>): WalletTransactionEntry[] {
    return record.balanceChanges.map(row => {
        const sent = row.role === 'sent';
        const fee = sent && record.fee && record.fee.asset === record.asset ? new Decimal(record.fee.amount) : null;
        const amount = fee ? new Decimal(row.change).plus(fee) : new Decimal(row.change);
        const send = amount.isZero() ? sent : amount.isNegative();
        const address = send ? record.to : row.address;
        return {
            address,
            category: send ? 'send' : 'receive',
            amount: amount.toFixed(AMOUNT_DECIMALS),
            label: labels.get(address),
            fee: fee ? fee.negated().toFixed(AMOUNT_DECIMALS) : undefined,
            blockheight: record.blockCount,
            blockindex: record.position,
            time: Math.floor(record.timestamp / 1000),
            txid: record.txid,
            type: record.type,
            method: record.method
        };
    });
}

/** A whole number argument of listtransactions, or null when the text is not one */
function wholeNumber(text: string): number | null {
    return /^\d+$/.test(text) ? Number(text) : null;
}

/** Number of transactions asked from the mirror per request: the route's maximum */
const HISTORY_PAGE_SIZE = 100;

/**
 * listtransactions: the history of the whole wallet in the Bitcoin CLI's form. The newest count entries after
 * skipping the newest skip, printed oldest first; an entry is one balance change of one wallet address, so a
 * transfer between two addresses of the wallet is a send and a receive
 */
export const listTransactionsCmd: CommandDef = {
    name: 'listtransactions',
    summary: 'The transactions of the wallet as JSON',
    usage: 'listtransactions [label] [count] [skip]',
    handler: async (args: string[]) => {
        try {
            const { positional } = parseArgs(args);
            if (positional.length > 3) {
                printError('Usage: listtransactions [label] [count] [skip]');
                return;
            }
            const label = positional[0] === undefined || positional[0] === '*' ? null : positional[0];
            const count = positional[1] === undefined ? 10 : wholeNumber(positional[1]);
            const skip = positional[2] === undefined ? 0 : wholeNumber(positional[2]);
            if (count === null || count < 1) {
                printError('count must be a positive integer');
                return;
            }
            if (skip === null) {
                printError('skip must be zero or a positive integer');
                return;
            }

            const wallet = await openWallet();
            if (!wallet) return;

            const known = await wallet.listKnownAddresses();
            const addresses = known.map(entry => entry.address);
            const labels = new Map<string, string>();
            for (const entry of known) {
                if (entry.label) labels.set(entry.address, entry.label);
            }

            // Newest first, a page at a time, until enough entries are read or the history ends
            const newestFirst: WalletTransactionEntry[] = [];
            let before: string | undefined;
            do {
                const page = await fetchWalletTransactions(addresses, HISTORY_PAGE_SIZE, before);
                for (const record of page.transactions) {
                    // reversed here, so that the entries of one transaction keep the mirror's order once the list is turned oldest first
                    const entries = walletTransactionEntries(record, labels).reverse();
                    newestFirst.push(...(label === null ? entries : entries.filter(entry => entry.label === label)));
                }
                before = page.transactions.length > 0 && page.next ? page.next : undefined;
            } while (before !== undefined && newestFirst.length < skip + count);

            printLine(JSON.stringify(newestFirst.slice(skip, skip + count).reverse(), null, 2));
        } catch (error) {
            printError(`listtransactions failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * wallet-transactions: the most recent transactions of one wallet address as a table, newest first
 */
export const walletTransactionsCmd: CommandDef = {
    name: 'wallet-transactions',
    summary: 'List the most recent transactions of a wallet address',
    usage: 'wallet-transactions [account_index] [address_index] [--count <n>]',
    handler: async (args: string[]) => {
        try {
            const { positional, options } = parseArgs(args);
            const count = options.has('count') ? parseInt(options.get('count') as string) : 20;
            if (!Number.isInteger(count) || count < 1) {
                printError('--count must be a positive integer');
                return;
            }

            const wallet = await openWallet();
            if (!wallet) return;

            const accountIndex = parseInt(positional[0] || '0');
            const addressIndex = parseInt(positional[1] || '0');
            const account = wallet.getAccount(accountIndex, addressIndex);

            const transactions = await fetchTransactions(account.address, count);
            if (transactions.length === 0) {
                printLine(`No transactions for ${account.address}`);
                return;
            }

            printLine(`\nTransactions of ${account.address}, newest first:`);
            printLine('='.repeat(140));
            printLine(`${'Time (UTC)'.padEnd(19)}  ${'Direction'.padEnd(14)} ${'Counterparty'.padEnd(36)} ${'Amount'.padStart(14)}  Transaction ID`);
            printLine('-'.repeat(140));
            for (const tx of transactions) {
                printLine(formatTransactionRow(tx, account.address));
            }
            printLine('='.repeat(140));

        } catch (error) {
            printError(`Failed to list transactions: ${describeApiError(error)}`);
        }
    }
};

/**
 * Chain information from the read mirror this wallet talks to
 */
export const getChainInfoCmd: CommandDef = {
    name: 'getchaininfo',
    summary: 'Show the chain, the read mirror and the node this wallet is connected to',
    usage: 'getchaininfo',
    handler: async () => {
        try {
            const status = await fetchStatus();
            printLine('\n=== Chain Information ===');
            printLine(`Read URL:     ${readApiBaseUrl()}`);
            printLine(`Node URL:     ${apiBaseUrl()} (transaction submission and multisig requests)`);
            printLine(`Network:      ${status.network}`);
            printLine(`Chain ID:     ${status.chainId}`);
            printLine(`Version:      ${status.version}`);
            printLine(`Block count:  ${status.height}`);
            printLine('');
            printLine('To use another read mirror or node, set READ_URL or NODE_URL before starting the CLI.');
        } catch (error) {
            printError(`getchaininfo failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * Balance and sequence of any address through the read mirror
 */
export const addressBalanceCmd: CommandDef = {
    name: 'addressbalance',
    summary: 'Display address balance',
    usage: 'addressbalance <address>',
    handler: async (args: string[]) => {
        try {
            const { positional } = parseArgs(args);
            if (positional.length === 0) {
                printError('Usage: addressbalance <address>');
                return;
            }
            const address = positional[0];
            if (!validateAddress(address)) {
                printError('Invalid Streembit address format.');
                return;
            }

            const info = await fetchAccount(address);
            printLine(`Address: ${info.address}`);
            printLine(`Balance (${AssetId.SBRIT}): ${info.balance}`);
            printLine(`Sequence: ${info.sequence}`);
        } catch (error) {
            printError(`addressbalance failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * The chain height of the read mirror this wallet talks to
 */
export const getBlockCountCmd: CommandDef = {
    name: 'getblockcount',
    summary: 'Get the total number of blocks in the blockchain',
    usage: 'getblockcount',
    handler: async () => {
        try {
            const status = await fetchStatus();
            printLine(String(status.height));
        } catch (error) {
            printError(`getblockcount failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * Find the used addresses of account 0 on the read mirror and record them as tracked, so that the wallet's
 * total and its address list include them; the step after wallet-restore
 */
export const walletDiscoverCmd: CommandDef = {
    name: 'wallet-discover',
    summary: 'Find the used addresses of the wallet and track them',
    usage: 'wallet-discover [max_addresses]',
    handler: async (args: string[]) => {
        try {
            const maxAddresses = parseInt(args[0] || '20');
            if (!Number.isInteger(maxAddresses) || maxAddresses < 1) {
                printError('max_addresses must be a positive integer');
                return;
            }

            const wallet = await openWallet();
            if (!wallet) return;

            const accounts = await wallet.discoverAccounts(0, maxAddresses);
            if (accounts.length === 0) {
                printLine(`No used address among the first ${maxAddresses} addresses of account 0`);
                return;
            }

            printLine('\nDiscovered addresses:');
            printLine('='.repeat(80));
            for (const account of accounts) {
                printLine(`[${account.index}] ${account.address}  ${account.balances.get(AssetId.SBRIT) ?? '0'} ${AssetId.SBRIT}  sequence ${account.sequence}`);
            }
            printLine('='.repeat(80));
            printLine(`${accounts.length} used address(es) found; addresses 0 to ${accounts[accounts.length - 1].index} of account 0 are tracked`);
        } catch (error) {
            printError(`Failed to discover addresses: ${describeApiError(error)}`);
        }
    }
};

/**
 * Show the recovery phrase. At a terminal only, and the password is always typed: WALLET_PASSWORD is not
 * used, so that a script on a machine that has it set cannot print the words
 */
export const walletMnemonicCmd: CommandDef = {
    name: 'wallet-mnemonic',
    summary: 'Show the recovery phrase of the wallet',
    usage: 'wallet-mnemonic',
    handler: async () => {
        try {
            if (!hasTerminal()) {
                printError('wallet-mnemonic needs a terminal: the recovery phrase is shown there and the password is typed.');
                return;
            }
            if (!hasScreen()) {
                printError('wallet-mnemonic shows the recovery phrase on the terminal only: its output cannot go to a file or a pipe.');
                return;
            }
            if (!await HDWallet.exists()) {
                printError('No wallet found. Use wallet-create or wallet-restore first.');
                return;
            }

            printLine('\n' + '='.repeat(70));
            printLine('WARNING: this displays the recovery phrase of the wallet.');
            printLine('Anyone with these words can restore the wallet and spend its funds.');
            printLine('Make sure no one sees the screen; never share the words or type them into a website.');
            printLine('='.repeat(70) + '\n');
            const confirmation = await promptText('Type "I UNDERSTAND" to continue: ');
            if (confirmation !== 'I UNDERSTAND') {
                printLine('Cancelled');
                return;
            }

            const password = await promptPassword('Enter wallet password: ');
            HDWallet.clearSession();
            const wallet = await HDWallet.initialize(password);
            const words = await wallet.exportMnemonic(password);

            printLine('\n' + '='.repeat(70));
            printLine(`Recovery phrase (${words.length} words), in order:\n`);
            for (let i = 0; i < words.length; i += 6) {
                printLine(words.slice(i, i + 6).map((word, offset) => `${(i + offset + 1).toString().padStart(2)}. ${word.padEnd(10)}`).join('  '));
            }
            printLine('\n' + '='.repeat(70));
        } catch (error) {
            printError(`Failed to show the recovery phrase: ${toErrorMessage(error)}`);
        }
    }
};

/** Copy the wallet file to a backup file; the handler of backupwallet and wallet-export */
async function backupWallet(command: string, args: string[]): Promise<void> {
    try {
        const { positional } = parseArgs(args);
        if (positional.length === 0) {
            printError(`Usage: ${command} <destination file>`);
            return;
        }
        if (!await HDWallet.exists()) {
            printError('No wallet found. Use wallet-create or wallet-restore first.');
            return;
        }
        const written = await HDWallet.backupTo(positional[0]);
        printNote(`Wallet backup written to ${written}; it is encrypted with the wallet password`);
    } catch (error) {
        printError(`${command} failed: ${toErrorMessage(error)}`);
    }
}

/**
 * backupwallet, the Bitcoin CLI's verb: copy the wallet file, still encrypted, with its labels and tracked addresses
 */
export const backupWalletCmd: CommandDef = {
    name: 'backupwallet',
    summary: 'Copy the wallet file to a backup file',
    usage: 'backupwallet <destination file>',
    handler: (args: string[]) => backupWallet('backupwallet', args)
};

/**
 * wallet-export: the same as backupwallet
 */
export const walletExportCmd: CommandDef = {
    name: 'wallet-export',
    summary: 'Copy the wallet file to a backup file (the same as backupwallet)',
    usage: 'wallet-export <destination file>',
    handler: (args: string[]) => backupWallet('wallet-export', args)
};

/**
 * Install a backup file as the wallet. At a terminal only: the backup's password is typed to check that the
 * file opens, and replacing an existing wallet is confirmed. The wallet keeps the backup's password
 */
export const walletImportCmd: CommandDef = {
    name: 'wallet-import',
    summary: 'Install a wallet backup file as the wallet',
    usage: 'wallet-import <backup file>',
    handler: async (args: string[]) => {
        try {
            const { positional } = parseArgs(args);
            if (positional.length === 0) {
                printError('Usage: wallet-import <backup file>');
                return;
            }
            if (!hasTerminal()) {
                printError('wallet-import needs a terminal: the password of the backup is typed there.');
                return;
            }
            if (!await confirmReplaceWallet()) {
                printLine('Wallet import cancelled');
                return;
            }

            const password = await promptPassword('Enter the password of the backup: ');
            printReplacedCopy(await HDWallet.installBackup(positional[0], password));
            const wallet = await HDWallet.initialize(password);
            printLine('Wallet imported successfully!');
            printLine(`Your first address: ${wallet.getAccount(0, 0).address}`);
        } catch (error) {
            printError(`Failed to import the wallet: ${toErrorMessage(error)}`);
        }
    }
};

// ---- Bitcoin CLI verbs ----
// These take the Bitcoin CLI's arguments and print what it prints: a bare value, or JSON for a structured answer,
// so that an exchange's scripts read them as they read bitcoin-cli. The wallet-* and getchaininfo commands above
// stay beside them with the output for a person.

/** SBRIT amounts are printed with eight decimals, as the Bitcoin CLI prints amounts */
const AMOUNT_DECIMALS = 8;

/**
 * getbalance: the wallet's total SBRIT, the sum over the tracked addresses, one mirror read per address
 */
export const getBalanceCmd: CommandDef = {
    name: 'getbalance',
    summary: 'The total SBRIT balance of the wallet',
    usage: 'getbalance',
    handler: async () => {
        try {
            const wallet = await openWallet();
            if (!wallet) return;

            const aggregate = await wallet.aggregateBalances();
            printLine(new Decimal(aggregate.totals.get(AssetId.SBRIT) ?? '0').toFixed(AMOUNT_DECIMALS));
        } catch (error) {
            printError(`getbalance failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * getnewaddress: the next unused address of account 0, with an optional label
 */
export const getNewAddressCmd: CommandDef = {
    name: 'getnewaddress',
    summary: 'A new address of the wallet for receiving payments',
    usage: 'getnewaddress [label]',
    handler: async (args: string[]) => {
        try {
            const { positional } = parseArgs(args);
            const label = positional.join(' ') || undefined;

            const wallet = await openWallet();
            if (!wallet) return;

            const result = await wallet.getNextAddress(0, label);
            printLine(result.address);
        } catch (error) {
            printError(`getnewaddress failed: ${toErrorMessage(error)}`);
        }
    }
};

/**
 * getcontract: the metadata of a contract's active version, as the SDK's fetchContract delivers it
 */
export const getContractCmd: CommandDef = {
    name: 'getcontract',
    summary: 'The metadata of a contract as JSON',
    usage: 'getcontract <contract_address>',
    handler: async (args: string[]) => {
        try {
            const { positional } = parseArgs(args);
            if (positional.length !== 1) {
                printError('Usage: getcontract <contract_address>');
                return;
            }
            const cid = positional[0];
            if (!validateAddress(cid) || !isContractAddress(cid)) {
                printError(`Invalid contract address: ${cid}`);
                return;
            }
            const meta = await fetchContract(cid);
            printLine(JSON.stringify({ cid: meta.cid, codehash: meta.codeHash, sandboxhash: meta.sandboxHash, location: meta.location }, null, 2));
        } catch (error) {
            printError(`getcontract failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * The record of a cell of the chain state, read from the mirror by its key: null while the mirror does not have
 * the cell. A cell that holds no record is an error.
 */
async function cellRecord(key: string): Promise<Record<string, unknown> | null> {
    const cell = await fetchCell(key);
    if (!cell) return null;
    if (typeof cell.value !== 'object' || cell.value === null || Array.isArray(cell.value)) {
        throw new Error(`The cell ${key} does not hold a record`);
    }
    return cell.value as Record<string, unknown>;
}

/** The ids a list cell of the chain state holds, read from the mirror by its key; none while the mirror does not have the cell */
async function cellIds(key: string): Promise<string[]> {
    const cell = await fetchCell(key);
    if (!cell) return [];
    if (!Array.isArray(cell.value) || !cell.value.every(id => typeof id === 'string')) {
        throw new Error(`The cell ${key} does not hold a list of ids`);
    }
    return cell.value as string[];
}

/**
 * getnode: the record of an Accountable Node as the chain holds it, with its status, its registered public keys
 * and its deposit; without an id, the ids of the ACTIVE Accountable Nodes. Read from the mirror.
 */
export const getNodeCmd: CommandDef = {
    name: 'getnode',
    summary: 'The record of an Accountable Node, or the ids of the active ones',
    usage: 'getnode [nodeId]',
    handler: async (args: string[]) => {
        try {
            const { positional } = parseArgs(args);
            if (positional.length > 1) {
                printError('Usage: getnode [nodeId]');
                return;
            }
            if (positional.length === 0) {
                printLine(JSON.stringify(await cellIds(NSkey.accountableNodeList()), null, 2));
                return;
            }
            const record = await cellRecord(NSkey.accountableNodeData(positional[0]));
            if (!record) {
                printError(`Accountable Node ${positional[0]} not found`);
                return;
            }
            printLine(JSON.stringify(record, null, 2));
        } catch (error) {
            printError(`getnode failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * getvalidator: the record of a validator as the chain holds it, with its status, its registered public keys and
 * its deposit, and rewardaddress, the owner of the deposit, which receives the validator's rewards; without an id,
 * the ids of the ACTIVE validators. Read from the mirror.
 */
export const getValidatorCmd: CommandDef = {
    name: 'getvalidator',
    summary: 'The record of a validator with its reward address, or the ids of the active ones',
    usage: 'getvalidator [validatorId]',
    handler: async (args: string[]) => {
        try {
            const { positional } = parseArgs(args);
            if (positional.length > 1) {
                printError('Usage: getvalidator [validatorId]');
                return;
            }
            if (positional.length === 0) {
                printLine(JSON.stringify(await cellIds(NSkey.validatorList()), null, 2));
                return;
            }
            const record = await cellRecord(NSkey.validatorData(positional[0]));
            if (!record) {
                printError(`Validator ${positional[0]} not found`);
                return;
            }
            const deposit = await fetchCell(NSkey.validatorDeposit(positional[0]));
            printLine(JSON.stringify({ ...record, rewardaddress: deposit && typeof deposit.value === 'string' ? deposit.value : undefined }, null, 2));
        } catch (error) {
            printError(`getvalidator failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * The --data option of a contract call: a JSON object with field names, or a file that holds one.
 * @returns The object, or null after the error is printed
 */
export function readCallData(dataInput: string): Record<string, unknown> | null {
    const dataPath = resolve(process.cwd(), dataInput);
    const text = existsSync(dataPath) && statSync(dataPath).isFile() ? readFileSync(dataPath, 'utf-8') : dataInput;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        printError(`--data is not valid JSON: ${toErrorMessage(error)}`);
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        printError('--data must be a JSON object with field names');
        return null;
    }
    return parsed as Record<string, unknown>;
}

/**
 * Call a contract method from a wallet address: the call is built and signed here with the SDK and submitted to
 * the Accountable Node. The chain status, the balance, the sequence and the contract's hashes are read from the
 * mirror. --data is a JSON object or a file that holds one; a method without
 * parameters needs none. The sender is account 0, address 0 unless --from names another wallet address.
 * The review, the confirmation, --yes and the retry on a refused sequence are those of sendtoaddress.
 */
const CALL_USAGE = 'contract-call-send --contract <address> --method <name> [--from <address>] [--data <json|file>] [--amount <n>] [--yes]';

export const contractCallSendCmd: CommandDef = {
    name: 'contract-call-send',
    summary: 'Call a contract method from a wallet address',
    usage: CALL_USAGE,
    handler: async (args: string[]) => {
        try {
            const yes = args.includes('--yes');
            const { options } = parseArgs(args.filter(arg => arg !== '--yes'));
            const contract = options.get('contract') ?? options.get('to');
            const method = options.get('method');
            let from = options.get('from');
            const amount = options.get('amount') ?? '0';
            const asset = (options.get('asset') ?? AssetId.SBRIT).toUpperCase();
            const dataInput = options.get('data');

            // An option given without a value is read as 'true': --method needs the name of the method
            if (!contract || !method || method === 'true') {
                printError(`Usage: ${CALL_USAGE}`);
                return;
            }
            if (!validateAddress(contract) || !isContractAddress(contract)) {
                printError(`Invalid contract address: ${contract}`);
                return;
            }
            if (from !== undefined && !validateAddress(from)) {
                printError(`Invalid from address: ${from}`);
                return;
            }
            if (asset !== AssetId.SBRIT) {
                printError(`Asset must be ${AssetId.SBRIT}`);
                return;
            }
            if (!/^0(\.0{1,8})?$/.test(amount) && !validateAmount(amount)) {
                printError('Amount must be zero or a positive number with up to 8 decimal places');
                return;
            }

            let data: Record<string, unknown> | undefined;
            if (dataInput !== undefined) {
                const parsed = readCallData(dataInput);
                if (!parsed) return;
                data = parsed;
            }

            const wallet = await openWallet();
            if (!wallet) return;

            if (from === undefined) {
                from = wallet.getAccount(0, 0).address;
            }
            const sender = await wallet.getAccountByAddress(from);
            if (!sender) {
                printError(`Address ${from} is not in this wallet. Use wallet-addresses to list the wallet addresses.`);
                return;
            }

            const chain = await fetchStatus();
            const info = await fetchAccount(from);
            const meta = await fetchContract(contract);
            if (!(Object.values(ContractLocation) as string[]).includes(meta.location)) {
                printError(`Unknown contract location "${meta.location}" for contract ${contract}`);
                return;
            }
            const required = new Decimal(amount).plus(SBRIT_FEE_AMOUNT).toString();
            if (new Decimal(info.balance).lt(required)) {
                printError(`Balance ${info.balance} ${AssetId.SBRIT} is below the amount plus fee of ${required} ${AssetId.SBRIT}`);
                return;
            }

            if (!yes) {
                printLine('\nContract call review:');
                printLine('='.repeat(60));
                printLine(`From:     ${from}`);
                printLine(`Contract: ${contract}`);
                printLine(`Method:   ${method}`);
                printLine(`Data:     ${data === undefined ? '(none)' : JSON.stringify(data)}`);
                printLine(`Amount:   ${amount} ${AssetId.SBRIT}`);
                printLine(`Fee:      ${SBRIT_FEE_AMOUNT} ${AssetId.SBRIT}`);
                printLine(`Sequence: ${info.sequence + 1}`);
                printLine(`Network:  ${chain.network}, chain ${chain.chainId}`);
                printLine('='.repeat(60));
                if (!hasTerminal()) {
                    printError('No terminal to confirm the contract call on. Add --yes to send without the confirmation.');
                    return;
                }
                if (!await promptConfirm('Sign and send this contract call?')) {
                    printLine('Contract call cancelled');
                    return;
                }
            }

            const call: ContractCallParams = { chainId: chain.chainId, version: chain.version, from, to: contract, method, data, codeHash: meta.codeHash, sandboxHash: meta.sandboxHash, location: meta.location as ContractLocation, amount, sequence: info.sequence + 1 };
            const senderKey = sender.privateKey;
            const result = await submitWithSequenceRetry(call.sequence, sequence => signedJson(buildContractCallTx({ ...call, sequence }), senderKey));
            if (result.resubmitted) {
                printNote(`The read mirror was behind the node: sent again with sequence ${result.sequence}`);
            }
            if (yes) {
                // The transaction id alone, as sendtoaddress answers; a call the node is still processing is noted beside it
                if (result.status === 'pending') {
                    printNote('Contract call accepted, still being processed by the node');
                }
                printLine(result.txid);
                return;
            }
            printLine(`\nContract call ${result.status === 'pending' ? 'accepted, still being processed by the node' : 'included in a block'}`);
            printLine(`Transaction ID: ${result.txid}`);

        } catch (error) {
            printError(`Failed to call the contract: ${describeApiError(error)}`);
        }
    }
};

/**
 * getbestblockhash: the hash of the tip block the read mirror has
 */
export const getBestBlockHashCmd: CommandDef = {
    name: 'getbestblockhash',
    summary: 'The hash of the best (tip) block',
    usage: 'getbestblockhash',
    handler: async () => {
        try {
            const status = await fetchStatus();
            printLine(status.tip);
        } catch (error) {
            printError(`getbestblockhash failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * gettransaction: one transaction by its id, read from the read mirror; a transaction the mirror has is in a block and final
 */
export const getTransactionCmd: CommandDef = {
    name: 'gettransaction',
    summary: 'One transaction by its id as JSON',
    usage: 'gettransaction <txid>',
    handler: async (args: string[]) => {
        try {
            const { positional } = parseArgs(args);
            if (positional.length !== 1) {
                printError('Usage: gettransaction <txid>');
                return;
            }
            const txid = positional[0].toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(txid)) {
                printError('The transaction id must be 64 hexadecimal characters');
                return;
            }

            const tx = await fetchTransaction(txid);
            if (!tx) {
                printError(`Transaction ${txid} was not found on the read mirror: it is not in a block yet, or the mirror has not received its block yet`);
                return;
            }
            printLine(JSON.stringify({ txid: tx.txid, amount: new Decimal(tx.amount).toFixed(8), asset: tx.asset, blockheight: tx.blockCount, time: Math.floor(tx.timestamp / 1000), type: tx.type, from: tx.from, to: tx.to, method: tx.method }, null, 2));
        } catch (error) {
            printError(`gettransaction failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * getblockchaininfo: the chain as the read mirror reports it, with the Bitcoin CLI's field names where one exists
 */
export const getBlockchainInfoCmd: CommandDef = {
    name: 'getblockchaininfo',
    summary: 'The state of the chain as JSON',
    usage: 'getblockchaininfo',
    handler: async () => {
        try {
            const status = await fetchStatus();
            printLine(JSON.stringify({ chain: status.network, blocks: status.height, bestblockhash: status.tip, chainid: status.chainId, version: status.version }, null, 2));
        } catch (error) {
            printError(`getblockchaininfo failed: ${describeApiError(error)}`);
        }
    }
};

/**
 * validateaddress: whether a string is a Streembit address, and whether it is a contract's; no wallet and no network
 */
export const validateAddressCmd: CommandDef = {
    name: 'validateaddress',
    summary: 'Check that an address is valid',
    usage: 'validateaddress <address>',
    handler: (args: string[]) => {
        const { positional } = parseArgs(args);
        if (positional.length === 0) {
            printError('Usage: validateaddress <address>');
            return;
        }
        const address = positional[0];
        const answer = validateAddress(address) ? { isvalid: true, address, iscontract: isContractAddress(address) } : { isvalid: false };
        printLine(JSON.stringify(answer, null, 2));
    }
};

/**
 * getwalletinfo: what the wallet file says about itself; the password is not needed
 */
export const getWalletInfoCmd: CommandDef = {
    name: 'getwalletinfo',
    summary: 'The state of the wallet file as JSON',
    usage: 'getwalletinfo',
    handler: async () => {
        try {
            if (!await HDWallet.exists()) {
                printError('No wallet found. Use wallet-create or wallet-restore first.');
                return;
            }
            const info = await HDWallet.fileInfo();
            printLine(JSON.stringify({ walletname: info.path, walletversion: info.version, network: info.network, createdat: info.createdAt, addresscount: info.addressCount }, null, 2));
        } catch (error) {
            printError(`getwalletinfo failed: ${toErrorMessage(error)}`);
        }
    }
};

/**
 * setlabel: set the label of a wallet address; an empty label removes it
 */
export const setLabelCmd: CommandDef = {
    name: 'setlabel',
    summary: 'Set the label of a wallet address',
    usage: 'setlabel <address> <label>',
    handler: async (args: string[]) => {
        try {
            const { positional } = parseArgs(args);
            if (positional.length === 0) {
                printError('Usage: setlabel <address> <label>');
                return;
            }
            const address = positional[0];
            const label = positional.slice(1).join(' ');
            if (!validateAddress(address)) {
                printError(`Invalid address: ${address}`);
                return;
            }

            const wallet = await openWallet();
            if (!wallet) return;

            const found = await wallet.getAccountByAddress(address);
            if (!found) {
                printError(`Address ${address} is not in this wallet. Use wallet-addresses to list the wallet addresses.`);
                return;
            }
            await wallet.setAddressLabel(address, label, found.accountIndex, found.addressIndex);
        } catch (error) {
            printError(`setlabel failed: ${toErrorMessage(error)}`);
        }
    }
};

/**
 * walletpassphrasechange: change the password of the wallet file. Unlike the Bitcoin CLI it takes no arguments:
 * a password on the command line is visible in the process list and the shell history, so both are typed at the terminal.
 */
export const walletPassphraseChangeCmd: CommandDef = {
    name: 'walletpassphrasechange',
    summary: 'Change the password of the wallet file',
    usage: 'walletpassphrasechange',
    handler: async () => {
        try {
            if (!hasTerminal()) {
                printError('walletpassphrasechange needs a terminal: the current and the new password are typed there.');
                return;
            }
            if (!await HDWallet.exists()) {
                printError('No wallet found. Use wallet-create or wallet-restore first.');
                return;
            }
            const current = await promptPassword('Enter current password: ');
            const next = await promptPasswordWithRequirements('Confirm new password: ');
            await HDWallet.changePassword(current, next);
            // The open session holds the old password
            HDWallet.clearSession();
            printNote('Wallet password changed');
        } catch (error) {
            printError(`walletpassphrasechange failed: ${toErrorMessage(error)}`);
        }
    }
};

/** Every wallet command, in the order help lists them is alphabetical anyway */
export const walletCommands: CommandDef[] = [
    walletCreateCmd,
    walletRestoreCmd,
    walletShowCmd,
    walletBalanceCmd,
    walletAddressesCmd,
    walletNewAddressCmd,
    sendToAddressCmd,
    listTransactionsCmd,
    walletTransactionsCmd,
    getChainInfoCmd,
    addressBalanceCmd,
    getBlockCountCmd,
    getBalanceCmd,
    getNewAddressCmd,
    getBestBlockHashCmd,
    getTransactionCmd,
    getContractCmd,
    getNodeCmd,
    getValidatorCmd,
    contractCallSendCmd,
    getBlockchainInfoCmd,
    validateAddressCmd,
    getWalletInfoCmd,
    setLabelCmd,
    walletPassphraseChangeCmd,
    walletDiscoverCmd,
    walletMnemonicCmd,
    backupWalletCmd,
    walletExportCmd,
    walletImportCmd
];
