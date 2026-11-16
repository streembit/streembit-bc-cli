/**
 * The commands that need no prompt, against a fake read mirror and a fake Accountable Node. Every read must
 * reach the mirror, the contract metadata of fetchContract included; the node receives signed transactions
 * only. Anything else the node receives fails the test.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streembit-cli-commands-'));
process.env.WALLET_DATA_DIR = tempDir;

import { configureApi, configureReadApi } from 'streembit-bc-sdk/api';
import { deriveFromSeed, seedFromMnemonic, createUserAddress, createContractAddress, generateKeyPair, validateAddress } from 'streembit-bc-sdk';
import { HDWallet } from '../src/wallet';
import { setNetwork } from '../src/config';
import { PassThrough } from 'node:stream';
import { splitArgs, registerCommand, clearCommands, startRepl, askShell } from '../src/cli/shell';
import { promptConfirm, promptPassword } from '../src/cli/input';
import { parseArgs } from '../src/cli/args';
import { addressBalanceCmd, getBlockCountCmd, getChainInfoCmd, walletTransactionsCmd, sendToAddressCmd, walletBalanceCmd, formatTransactionRow, getBestBlockHashCmd, getBlockchainInfoCmd, getBalanceCmd, getNewAddressCmd, validateAddressCmd, getWalletInfoCmd, setLabelCmd, getTransactionCmd, getContractCmd, contractCallSendCmd, backupWalletCmd } from '../src/commands/wallet';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'Wallet-File#2026';
const ADDRESS0 = deriveFromSeed(seedFromMnemonic(MNEMONIC), 0, 0).address;
const OTHER = createUserAddress(generateKeyPair().publicKey);
const CONTRACT = createContractAddress('dist/node/smart-contracts/demo.js', generateKeyPair().publicKey, 1337);
const TXID = 'a'.repeat(64);
const SUBMITTED_TXID = 'c'.repeat(64);

let server: Server;
let node: Server;
let nodeRequests: string[] = [];
let submitted: Array<Record<string, unknown>> = [];
let lines: string[] = [];
let errors: string[] = [];
const originalLog = console.log;
const originalError = console.error;

function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '';
    const reply = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    if (url === '/api/v1/status') return reply(200, { chainId: 1337, version: 1, network: 'devnet', height: 42, tip: 'ab'.repeat(32) });
    if (url === `/api/v1/accounts/${ADDRESS0}`) return reply(200, { address: ADDRESS0, balance: '2', sequence: 1 });
    if (url === `/api/v1/accounts/${ADDRESS0}/transactions?limit=20`) {
        return reply(200, { transactions: [{ txid: 'a'.repeat(64), type: 'transfer', from: OTHER, to: ADDRESS0, amount: '2', asset: 'SBRIT', timestamp: 1760700000000, blockCount: 7 }] });
    }
    if (url === `/api/v1/transactions/${TXID}`) return reply(200, { txid: TXID, type: 'transfer', from: OTHER, to: ADDRESS0, amount: '2', asset: 'SBRIT', timestamp: 1760700000123, blockCount: 7, position: 0 });
    if (url === `/api/v1/contracts/${CONTRACT}`) return reply(200, { cid: CONTRACT, codeHash: '1'.repeat(64), sandboxHash: '2'.repeat(64), location: 'file_system' });
    if (url.startsWith('/api/v1/transactions/')) return reply(404, { error: 'ERR_KEY_NOT_FOUND', message: 'Transaction not found', details: { txid: url.slice('/api/v1/transactions/'.length), height: 42 } });
    if (url.startsWith('/api/v1/accounts/')) return reply(200, { address: decodeURIComponent(url.slice('/api/v1/accounts/'.length)), balance: '0', sequence: 0 });
    reply(404, { error: 'ERR_KEY_NOT_FOUND', message: 'not found' });
}

/** The fake node: it accepts a transaction with sequence 3 only, so every submission also takes the retry with the sequence the node names */
function handleNode(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '';
    nodeRequests.push(`${req.method} ${url}`);
    const reply = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
        if (req.method === 'POST' && url === '/api/v1/transactions') {
            const tx = JSON.parse(text) as Record<string, unknown>;
            if (tx.sequence !== 3) return reply(400, { error: 'ERR_INVALID_SEQUENCE', message: `Transaction carries sequence ${tx.sequence}, the chain expects 3`, details: { field: 'sequence', expected: 3 } });
            submitted.push(tx);
            return reply(200, { txid: SUBMITTED_TXID, status: 'included' });
        }
        reply(404, { error: 'ERR_KEY_NOT_FOUND', message: 'not found' });
    });
}

function port(of: Server): number {
    const address = of.address();
    if (!address || typeof address === 'string') throw new Error('server has no port');
    return address.port;
}

function output(): string {
    return lines.join('\n');
}

describe('Wallet commands', () => {
    before(async () => {
        server = createServer(handle);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        node = createServer(handleNode);
        await new Promise<void>(resolve => node.listen(0, '127.0.0.1', resolve));
        configureReadApi(`http://127.0.0.1:${port(server)}`);
        configureApi(`http://127.0.0.1:${port(node)}`);
        setNetwork('devnet');
        const wallet = await HDWallet.createNew(PASSWORD, MNEMONIC);
        await wallet.saveToFile(PASSWORD);
        console.log = (message?: unknown) => { lines.push(String(message)); };
        console.error = (message?: unknown) => { errors.push(String(message)); };
    });

    after(async () => {
        console.log = originalLog;
        console.error = originalError;
        await new Promise<void>(resolve => server.close(() => resolve()));
        await new Promise<void>(resolve => node.close(() => resolve()));
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function reset(): void {
        lines = [];
        errors = [];
        nodeRequests = [];
        submitted = [];
    }

    it('splits and parses arguments like the node CLI, including --flag=value', () => {
        assert.deepEqual(splitArgs(`sendtoaddress ${ADDRESS0} ${OTHER} SBRIT "1.5"`), ['sendtoaddress', ADDRESS0, OTHER, 'SBRIT', '1.5']);
        const parsed = parseArgs(['0', '--count=5', '--label', 'rent', '--flag']);
        assert.deepEqual(parsed.positional, ['0']);
        assert.deepEqual([...parsed.options], [['count', '5'], ['label', 'rent'], ['flag', 'true']]);
    });

    it('an answer typed at a prompt inside the shell goes to the prompt alone, not to the shell as a command', async () => {
        reset();
        const typed = new PassThrough();
        const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
        const realExit = process.exit;
        let exitCode: unknown = 'not called';
        let exited: () => void = () => undefined;
        const shellClosed = new Promise<void>(resolve => { exited = resolve; });
        Object.defineProperty(process, 'stdin', { value: typed, configurable: true });
        // The shell exits the process when its input ends; the test records the exit instead of taking it
        process.exit = ((code?: number) => { exitCode = code; exited(); }) as typeof process.exit;
        try {
            // The command tells the test when its question is asked and when it is answered, so the test waits on events, not on time
            let asked: () => void = () => undefined;
            let answered: (answer: boolean) => void = () => undefined;
            const questionAsked = new Promise<void>(resolve => { asked = resolve; });
            const questionAnswered = new Promise<boolean>(resolve => { answered = resolve; });
            let runs = 0;
            registerCommand({ name: 'ask-test', summary: 'asks a confirmation', handler: async () => { runs++; const answer = promptConfirm('Sign and send?'); asked(); answered(await answer); } });
            await startRepl('test> ');
            typed.write('ask-test\n');
            await questionAsked;
            typed.write('y\n');
            assert.equal(await questionAnswered, true);
            assert.deepEqual(errors, []);

            // The shell is still running: a second question goes through it as well
            const second = askShell('still running? ');
            assert.notEqual(second, null);
            typed.write('ok\n');
            assert.equal(await second, 'ok');
            assert.deepEqual(errors, []);

            // The answers are not in the shell's history: the up arrow brings back the command, which runs a second time
            typed.write('\u001b[A');
            typed.write('\n');
            for (let waited = 0; runs < 2 && errors.length === 0 && waited < 2000; waited += 5) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.deepEqual(errors, []);
            assert.equal(runs, 2);
            typed.write('n\n');
        } finally {
            // Close the shell the way a person does, by ending its input, so that nothing of it is left for the tests that follow
            typed.end();
            await shellClosed;
            process.exit = realExit;
            if (realStdin) Object.defineProperty(process, 'stdin', realStdin);
            clearCommands();
        }
        assert.equal(exitCode, 0);
        assert.equal(askShell('closed?'), null);
        assert.match(output(), /Goodbye!/);
    });

    it('the hidden password prompt takes a pasted password in full, any alphabet, and handles backspace and keys inside a chunk', async () => {
        const typed = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (mode: boolean) => void };
        typed.isTTY = true;
        typed.isRaw = false;
        typed.setRawMode = () => undefined;
        const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
        const realWrite = process.stdout.write;
        Object.defineProperty(process, 'stdin', { value: typed, configurable: true });
        // What the prompt writes is recorded and still written: standard output also carries the test runner's own report, which must not be swallowed
        let echoed = '';
        process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
            if (typeof args[0] === 'string') echoed += args[0];
            return realWrite.apply(process.stdout, args);
        }) as typeof process.stdout.write;
        const ask = async (chunks: Array<string | Buffer>): Promise<string> => {
            const answer = promptPassword('Password: ');
            for (const chunk of chunks) typed.write(chunk);
            return answer;
        };
        try {
            assert.equal(await ask(['Wallet-File#2026\r\n']), 'Wallet-File#2026');
            // The password itself is never written: the prompt, one star per character and the line end
            assert.equal(echoed, `Password: ${'*'.repeat(16)}\n`);
            assert.equal(await ask(['W', 'a', 'l', '\r']), 'Wal');
            assert.equal(await ask(['Jelszó-Árvíz#2026\r']), 'Jelszó-Árvíz#2026');
            const split = Buffer.from('é', 'utf8');
            assert.equal(await ask([split.subarray(0, 1), split.subarray(1), '\r']), 'é');
            assert.equal(await ask(['abé', '\u007f', '\u007fc\r']), 'ac');
            assert.equal(await ask(['ab', '\u001b[A', '\tc\u001b[3~d\r']), 'abcd');
            // An escape sequence split across chunks at every boundary leaves nothing of itself in the password
            assert.equal(await ask(['ab', '\u001b', '[A', 'c\r']), 'abc');
            assert.equal(await ask(['ab\u001b[', 'Ac\r']), 'abc');
            assert.equal(await ask(['ab\u001b[1', ';5', 'Cc\r']), 'abc');
            assert.equal(await ask(['ab\u001b', 'O', 'Pc\r']), 'abc');
            assert.equal(await ask(['ab\u001b[15', '~c[A]\r']), 'abc[A]');
            // The Esc key alone: what is typed after the sequence time has passed is password again
            const slow = promptPassword('Password: ');
            typed.write('ab\u001b');
            await new Promise(resolve => setTimeout(resolve, 600));
            typed.write('[Ac\r');
            assert.equal(await slow, 'ab[Ac');
        } finally {
            process.stdout.write = realWrite;
            if (realStdin) Object.defineProperty(process, 'stdin', realStdin);
        }
    });

    it('getblockcount and getchaininfo read the status', async () => {
        reset();
        await getBlockCountCmd.handler([]);
        assert.equal(output(), '42');
        reset();
        await getChainInfoCmd.handler([]);
        assert.match(output(), /Network:\s+devnet/);
        assert.match(output(), /Chain ID:\s+1337/);
    });

    it('addressbalance answers any address and refuses a bad one', async () => {
        reset();
        await addressBalanceCmd.handler([ADDRESS0]);
        assert.match(output(), /Balance \(SBRIT\): 2/);
        assert.match(output(), /Sequence: 1/);
        reset();
        await addressBalanceCmd.handler(['nope']);
        assert.match(errors.join('\n'), /Invalid Streembit address format/);
        reset();
        await addressBalanceCmd.handler([]);
        assert.match(errors.join('\n'), /Usage: addressbalance/);
    });

    it('wallet-balance and wallet-transactions use the unlocked wallet', async () => {
        reset();
        await walletBalanceCmd.handler([]);
        assert.match(output(), new RegExp(`Address:\\s+${ADDRESS0}`));
        assert.match(output(), /Balance:\s+2 SBRIT/);
        reset();
        await walletTransactionsCmd.handler([]);
        assert.match(output(), /received/);
        assert.match(output(), new RegExp(OTHER));
        assert.match(output(), new RegExp('a'.repeat(64)));
        reset();
        await walletTransactionsCmd.handler(['0', '0', '--count', '0']);
        assert.match(errors.join('\n'), /--count must be a positive integer/);
    });

    it('formats a history row with the direction seen from the wallet address', () => {
        const row = formatTransactionRow({ txid: 'f'.repeat(64), type: 'transfer', from: ADDRESS0, to: OTHER, amount: '1', timestamp: 1760700000000 }, ADDRESS0);
        assert.match(row, /sent/);
        assert.match(row, new RegExp(OTHER));
        const call = formatTransactionRow({ txid: 'f'.repeat(64), type: 'contract_call', from: ADDRESS0, to: OTHER, amount: '0', timestamp: 0, method: 'register' }, ADDRESS0);
        assert.match(call, /call register/);
    });

    it('sendtoaddress stops on bad arguments, the wrong asset, an unknown sender and a short balance before any prompt', async () => {
        reset();
        await sendToAddressCmd.handler(['x', OTHER, 'SBRIT', '1']);
        assert.match(errors.join('\n'), /Invalid from address/);
        reset();
        await sendToAddressCmd.handler([ADDRESS0, OTHER, 'GOLD', '1']);
        assert.match(errors.join('\n'), /Asset must be SBRIT/);
        reset();
        await sendToAddressCmd.handler([ADDRESS0, OTHER, 'SBRIT', 'abc']);
        assert.match(errors.join('\n'), /Amount must be/);
        reset();
        await sendToAddressCmd.handler([OTHER, ADDRESS0, 'SBRIT', '1']);
        assert.match(errors.join('\n'), /not in this wallet/);
        reset();
        await sendToAddressCmd.handler([ADDRESS0, OTHER, 'SBRIT', '5']);
        assert.match(errors.join('\n'), /below the amount plus fee of 5.01 SBRIT/);
        reset();
        await sendToAddressCmd.handler([OTHER]);
        assert.match(errors.join('\n'), /Usage: sendtoaddress/);
        reset();
        await sendToAddressCmd.handler([ADDRESS0, OTHER, 'SBRIT', '1', '--from', ADDRESS0]);
        assert.match(errors.join('\n'), /--from cannot be used/);
        reset();
        await sendToAddressCmd.handler([OTHER, '1']);
        assert.match(errors.join('\n'), /No terminal to confirm the transaction on/);
        assert.deepEqual(nodeRequests, []);
    });

    it('the Bitcoin CLI chain commands print a bare value or JSON read from the mirror', async () => {
        reset();
        await getBestBlockHashCmd.handler([]);
        assert.equal(output(), 'ab'.repeat(32));
        reset();
        await getBlockchainInfoCmd.handler([]);
        assert.deepEqual(JSON.parse(output()), { chain: 'devnet', blocks: 42, bestblockhash: 'ab'.repeat(32), chainid: 1337, version: 1 });
        reset();
        await validateAddressCmd.handler([ADDRESS0]);
        assert.deepEqual(JSON.parse(output()), { isvalid: true, address: ADDRESS0, iscontract: false });
        reset();
        await validateAddressCmd.handler([CONTRACT]);
        assert.deepEqual(JSON.parse(output()), { isvalid: true, address: CONTRACT, iscontract: true });
        reset();
        await validateAddressCmd.handler(['nope']);
        assert.deepEqual(JSON.parse(output()), { isvalid: false });
        assert.deepEqual(nodeRequests, []);
    });

    it('gettransaction prints the transaction of the mirror and reports an unknown or malformed id', async () => {
        reset();
        await getTransactionCmd.handler([TXID.toUpperCase()]);
        assert.deepEqual(JSON.parse(output()), { txid: TXID, amount: '2.00000000', asset: 'SBRIT', blockheight: 7, time: 1760700000, type: 'transfer', from: OTHER, to: ADDRESS0 });
        reset();
        await getTransactionCmd.handler(['b'.repeat(64)]);
        assert.match(errors.join('\n'), /was not found on the read mirror/);
        reset();
        await getTransactionCmd.handler(['xyz']);
        assert.match(errors.join('\n'), /64 hexadecimal characters/);
        reset();
        await getTransactionCmd.handler([]);
        assert.match(errors.join('\n'), /Usage: gettransaction/);
        assert.deepEqual(nodeRequests, []);
    });

    it('the Bitcoin CLI wallet commands answer from the wallet file and the mirror', async () => {
        reset();
        await getBalanceCmd.handler([]);
        assert.equal(output(), '2.00000000');
        reset();
        await getNewAddressCmd.handler(['rent']);
        const fresh = output();
        assert.equal(validateAddress(fresh), true);
        reset();
        await setLabelCmd.handler([fresh, 'cold storage']);
        assert.deepEqual(errors, []);
        assert.equal((await HDWallet.getInstance().listKnownAddresses()).find(known => known.address === fresh)?.label, 'cold storage');
        reset();
        await setLabelCmd.handler([OTHER, 'x']);
        assert.equal(errors.length, 1);
        reset();
        await getWalletInfoCmd.handler([]);
        const info = JSON.parse(output());
        assert.equal(info.network, 'devnet');
        assert.equal(info.walletversion, 1);
        assert.equal(typeof info.addresscount, 'number');
        reset();
        const backup = path.join(tempDir, 'backup.json');
        await backupWalletCmd.handler([backup]);
        assert.match(errors.join('\n'), /^Wallet backup written to /);
        assert.equal(fs.existsSync(backup), true);
        reset();
        await backupWalletCmd.handler([backup]);
        assert.match(errors.join('\n'), /already exists/);
        assert.deepEqual(nodeRequests, []);
    });

    it('sendtoaddress --yes signs, retries with the sequence the node names and prints the bare transaction id', async () => {
        reset();
        await sendToAddressCmd.handler([OTHER, '1', '--yes']);
        assert.equal(output(), SUBMITTED_TXID);
        assert.match(errors.join('\n'), /sent again with sequence 3/);
        assert.deepEqual(nodeRequests, ['POST /api/v1/transactions', 'POST /api/v1/transactions']);
        assert.equal(submitted.length, 1);
        assert.equal(submitted[0].type, 'transfer');
        assert.equal(submitted[0].from, ADDRESS0);
        assert.equal(submitted[0].to, OTHER);
        assert.equal(submitted[0].amount, '1');
        assert.equal(submitted[0].sequence, 3);
        reset();
        await sendToAddressCmd.handler([ADDRESS0, OTHER, 'SBRIT', '0.5', '--yes']);
        assert.equal(output(), SUBMITTED_TXID);
        assert.equal(submitted[0].amount, '0.5');
    });

    it('getcontract and contract-call-send read the contract with the SDK and submit the signed call', async () => {
        reset();
        await getContractCmd.handler([CONTRACT]);
        assert.deepEqual(JSON.parse(output()), { cid: CONTRACT, codehash: '1'.repeat(64), sandboxhash: '2'.repeat(64), location: 'file_system' });
        reset();
        await getContractCmd.handler([ADDRESS0]);
        assert.match(errors.join('\n'), /Invalid contract address/);
        reset();
        await contractCallSendCmd.handler(['--contract', CONTRACT, '--method', 'register', '--data', '{"name":"alice"}', '--amount', '1.5', '--yes']);
        assert.equal(output(), SUBMITTED_TXID);
        assert.deepEqual(nodeRequests, ['POST /api/v1/transactions', 'POST /api/v1/transactions']);
        assert.equal(submitted[0].type, 'contract_call');
        assert.equal(submitted[0].to, CONTRACT);
        assert.equal(submitted[0].method, 'register');
        assert.equal(submitted[0].amount, '1.5');
        assert.equal(submitted[0].data, Buffer.from('{"name":"alice"}', 'utf8').toString('hex'));
        assert.equal(submitted[0].sequence, 3);
        reset();
        const dataFile = path.join(tempDir, 'call-data.json');
        fs.writeFileSync(dataFile, JSON.stringify({ name: 'from-file' }));
        await contractCallSendCmd.handler(['--contract', CONTRACT, '--method', 'register', '--data', dataFile, '--yes']);
        assert.equal(submitted[0].data, Buffer.from('{"name":"from-file"}', 'utf8').toString('hex'));
        assert.equal(submitted[0].amount, '0');
        reset();
        await contractCallSendCmd.handler(['--contract', CONTRACT, '--method', 'ping', '--yes']);
        assert.equal(submitted[0].data, '');
        reset();
        await contractCallSendCmd.handler(['--contract', CONTRACT, '--method', 'ping', '--data', '[1,2]', '--yes']);
        assert.match(errors.join('\n'), /--data must be a JSON object/);
        reset();
        await contractCallSendCmd.handler(['--contract', CONTRACT, '--yes']);
        assert.match(errors.join('\n'), /Usage: contract-call-send/);
        reset();
        await contractCallSendCmd.handler(['--contract', CONTRACT, '--method', 'ping', '--amount', '5', '--yes']);
        assert.match(errors.join('\n'), /below the amount plus fee of 5.01 SBRIT/);
        assert.equal(submitted.length, 0);
        reset();
        await contractCallSendCmd.handler(['--contract', CONTRACT, '--method', 'ping']);
        assert.match(errors.join('\n'), /No terminal to confirm the contract call on/);
        assert.equal(submitted.length, 0);
    });
});
