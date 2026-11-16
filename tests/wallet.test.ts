/**
 * The HD wallet of the CLI: keys and file from the SDK, balances from a fake read mirror. The node address
 * points at a closed port, so a read that went to the Accountable Node would fail the test. WALLET_DATA_DIR points at a temporary directory for the whole file.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streembit-cli-wallet-'));
process.env.WALLET_DATA_DIR = tempDir;

import { configureApi, configureReadApi } from 'streembit-bc-sdk/api';
import { createUserAddress, deriveFromSeed, seedFromMnemonic } from 'streembit-bc-sdk';
import { spawn } from 'node:child_process';
import { HDWallet } from '../src/wallet';
import { withFileLock, writeJsonToFile, readJsonFromFile } from '../src/files';
import { WalletPath, Network, setNetwork } from '../src/config';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'Wallet-File#2026';
const ADDRESS0 = deriveFromSeed(seedFromMnemonic(MNEMONIC), 0, 0).address;
const ADDRESS1 = deriveFromSeed(seedFromMnemonic(MNEMONIC), 0, 1).address;

let server: Server;

/** The fake mirror: address 0 holds 12.5 at sequence 3, address 1 spent everything (0 at sequence 2), others are unseen */
function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '';
    const reply = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const match = url.match(/^\/api\/v1\/accounts\/([^/?]+)$/);
    if (match) {
        const address = decodeURIComponent(match[1]);
        if (address === ADDRESS0) return reply(200, { address, balance: '12.5', sequence: 3 });
        if (address === ADDRESS1) return reply(200, { address, balance: '0', sequence: 2 });
        return reply(200, { address, balance: '0', sequence: 0 });
    }
    reply(404, { error: 'ERR_KEY_NOT_FOUND', message: 'not found' });
}

describe('HDWallet (CLI)', () => {
    before(async () => {
        server = createServer(handle);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('server has no port');
        configureReadApi(`http://127.0.0.1:${address.port}`);
        configureApi('http://127.0.0.1:1');
        setNetwork('devnet');
    });

    after(async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('derives the same addresses as the SDK and refuses an invalid phrase', () => {
        const wallet = HDWallet.__createForTesting(MNEMONIC);
        assert.equal(wallet.getAccount(0, 0).address, ADDRESS0);
        assert.equal(wallet.getAccount(0, 0).address, createUserAddress(wallet.getAccount(0, 0).publicKey));
        assert.throws(() => HDWallet.__createForTesting('invalid mnemonic phrase'), /Invalid mnemonic phrase/);
    });

    it('creates, saves, reloads and tracks addresses in the data directory', async () => {
        assert.equal(await HDWallet.exists(), false);
        const created = await HDWallet.createNew(PASSWORD, MNEMONIC);
        await created.saveToFile(PASSWORD);
        assert.equal(await HDWallet.exists(), true);
        assert.ok(fs.existsSync(WalletPath()));

        HDWallet.clearSession();
        assert.equal(HDWallet.isAuthenticated(), false);
        const loaded = await HDWallet.initialize(PASSWORD);
        assert.equal(loaded.getMnemonic(), MNEMONIC);
        assert.equal(HDWallet.isAuthenticated(), true);

        // index 0 is the wallet's own address, tracked from the start: the first next address is index 1, as the SDK's metadata rules define it
        const first = await loaded.getNextAddress(0, 'savings');
        assert.equal(first.index, 1);
        assert.equal(first.address, ADDRESS1);
        const next = await loaded.getNextAddress(0);
        assert.equal(next.index, 2);
        assert.equal(next.address, deriveFromSeed(seedFromMnemonic(MNEMONIC), 0, 2).address);
        const known = await loaded.listKnownAddresses();
        assert.deepEqual(known.map(k => [k.addressIndex, k.label]), [[0, undefined], [1, 'savings'], [2, undefined]]);

        const found = await loaded.getAccountByAddress(ADDRESS1);
        assert.equal(found?.addressIndex, 1);
        assert.equal(await loaded.getAccountByAddress(createUserAddress(deriveFromSeed(seedFromMnemonic(MNEMONIC), 5, 0).publicKey)), null);
    });

    it('refuses a wrong password on reload', async () => {
        HDWallet.clearSession();
        await assert.rejects(HDWallet.initialize('Wrong-Password#2026'), /Decryption failed/);
        await HDWallet.initialize(PASSWORD);
    });

    it('reads balances and sequences from the mirror', async () => {
        const wallet = HDWallet.getInstance();
        assert.deepEqual(await wallet.getAccountInfo(0, 0), { address: ADDRESS0, balance: '12.5', sequence: 3 });
        assert.equal(await wallet.checkBalance(0, 0), '12.5');
        assert.deepEqual([...(await wallet.getAccountBalances(0, 1))], [['SBRIT', '0']]);
        await assert.rejects(wallet.checkBalance(0, 0, 'GOLD' as never), /not available/);
    });

    it('aggregates the tracked addresses and discovers used ones', async () => {
        const wallet = HDWallet.getInstance();
        const aggregate = await wallet.aggregateBalances();
        assert.equal(aggregate.totals.get('SBRIT'), '12.5');
        assert.equal(aggregate.addresses.length, 3);

        const used = await wallet.discoverAccounts(0, 5);
        assert.deepEqual(used.map(u => [u.index, u.sequence]), [[0, 3], [1, 2]]);
    });

    it('reports the file, backs it up without overwriting and installs a backup only with its password', async () => {
        const info = await HDWallet.fileInfo();
        assert.equal(info.path, WalletPath());
        assert.equal(info.version, 1);
        assert.equal(info.addressCount, (await HDWallet.getInstance().listKnownAddresses()).length);

        const backup = path.join(tempDir, 'backup.json');
        assert.equal(await HDWallet.backupTo(backup), backup);
        assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf-8')), JSON.parse(fs.readFileSync(WalletPath(), 'utf-8')));
        await assert.rejects(HDWallet.backupTo(backup), /already exists/);

        await assert.rejects(HDWallet.installBackup(backup, 'Wrong-Password#2026'));
        assert.equal(HDWallet.isAuthenticated(), true);
        await HDWallet.installBackup(backup, PASSWORD);
        assert.equal(HDWallet.isAuthenticated(), false);
        const wallet = await HDWallet.initialize(PASSWORD);
        assert.equal(wallet.getAccount(0, 0).address, ADDRESS0);
    });

    it('replaces a file in one step: a reader never finds it half-written, and no temporary file is left', async () => {
        const dir = path.join(tempDir, 'atomic');
        const target = path.join(dir, 'data.json');
        const small = { name: 'small', filler: 'a'.repeat(1000) };
        const large = { name: 'large', filler: 'b'.repeat(1024 * 1024) };

        await writeJsonToFile(target, small);
        assert.deepEqual(await readJsonFromFile(target), small);
        assert.deepEqual(fs.readdirSync(dir), ['data.json']);

        // While the file is rewritten again and again, every read parses and is one of the two contents in full
        let writing = true;
        let reads = 0;
        const problems: string[] = [];
        const reader = (async () => {
            while (writing) {
                try {
                    const text = fs.readFileSync(target, 'utf-8');
                    const parsed = JSON.parse(text);
                    if (parsed.filler.length !== (parsed.name === 'small' ? small : large).filler.length) problems.push(`cut content of ${text.length} characters`);
                } catch (error) {
                    problems.push(error instanceof Error ? error.message : String(error));
                }
                reads++;
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        })();
        try {
            for (let round = 0; round < 40; round++) {
                await writeJsonToFile(target, round % 2 === 0 ? large : small);
            }
        } finally {
            // The reader is stopped whatever happens to the writes: left running it would read for ever
            writing = false;
            await reader;
        }
        assert.ok(reads > 20, `only ${reads} reads`);
        assert.deepEqual(problems.slice(0, 3), []);
        assert.deepEqual(fs.readdirSync(dir), ['data.json']);

        // A write that fails leaves the file as it was and no temporary file
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        await assert.rejects(writeJsonToFile(target, circular));
        fs.mkdirSync(path.join(dir, 'folder'));
        await assert.rejects(writeJsonToFile(path.join(dir, 'folder'), small));
        assert.deepEqual(fs.readdirSync(dir).sort(), ['data.json', 'folder']);
        assert.equal((await readJsonFromFile(target)).name, 'small');

        // The permissions of an existing file are kept (POSIX; Windows has no such permissions)
        if (process.platform !== 'win32') {
            fs.chmodSync(target, 0o600);
            await writeJsonToFile(target, small);
            assert.equal(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    it('runs one action at a time under the wallet file lock, frees it after a failure and takes over a lock left by a dead process', async () => {
        const target = path.join(tempDir, 'locked.json');
        const lockPath = `${target}.lock`;

        // Three actions started together never overlap, and the lock file is gone after each
        let running = 0;
        let overlapped = false;
        const order: number[] = [];
        await Promise.all([1, 2, 3].map(id => withFileLock(target, async () => {
            if (++running > 1) overlapped = true;
            assert.equal(fs.existsSync(lockPath), true);
            await new Promise(resolve => setTimeout(resolve, 60));
            order.push(id);
            running--;
        })));
        assert.equal(overlapped, false);
        assert.equal(order.length, 3);
        assert.equal(fs.existsSync(lockPath), false);

        // An action that throws frees the lock, and its error reaches the caller
        await assert.rejects(withFileLock(target, async () => { throw new Error('write failed'); }), /write failed/);
        assert.equal(fs.existsSync(lockPath), false);
        assert.equal(await withFileLock(target, async () => 'next'), 'next');

        // A lock older than the stale age, left by a process that died, is taken over
        fs.writeFileSync(lockPath, 'dead-process');
        const old = new Date(Date.now() - 60000);
        fs.utimesSync(lockPath, old, old);
        assert.equal(await withFileLock(target, async () => 'took over'), 'took over');
        assert.equal(fs.existsSync(lockPath), false);

        // A fresh lock of another process is waited for, not taken: the action runs only after that lock is gone
        fs.writeFileSync(lockPath, 'live-process');
        let ran = false;
        const waiting = withFileLock(target, async () => { ran = true; });
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(ran, false);
        assert.equal(fs.readFileSync(lockPath, 'utf-8'), 'live-process');
        fs.rmSync(lockPath);
        await waiting;
        assert.equal(ran, true);
        assert.equal(fs.existsSync(lockPath), false);
    });

    it('gives processes that ask for a new address at the same time different addresses', async () => {
        const wallet = HDWallet.getInstance();
        const before = (await wallet.listKnownAddresses()).filter(known => known.accountIndex === 0).map(known => known.addressIndex);
        const first = Math.max(...before) + 1;
        const mirror = server.address();
        if (!mirror || typeof mirror === 'string') throw new Error('server has no port');

        const PROCESSES = 6;
        const runs = await Promise.all(Array.from({ length: PROCESSES }, (_unused, n) => new Promise<{ code: number | null; out: string; err: string }>(resolve => {
            const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', 'getnewaddress', `deposit-${n}`], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WALLET_DATA_DIR: tempDir, WALLET_PASSWORD: PASSWORD, READ_URL: `http://127.0.0.1:${mirror.port}`, FORCE_COLOR: '0' } });
            let out = '';
            let err = '';
            child.stdout.on('data', chunk => { out += chunk; });
            child.stderr.on('data', chunk => { err += chunk; });
            child.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
        })));

        for (const run of runs) {
            assert.equal(run.code, 0, run.err);
        }
        const expected = Array.from({ length: PROCESSES }, (_unused, n) => wallet.getAccount(0, first + n).address);
        assert.deepEqual(runs.map(run => run.out).sort(), [...expected].sort());

        // Every address is recorded with the label of the process that got it, and no lock is left
        const known = await wallet.listKnownAddresses();
        const labels = runs.map(run => known.find(entry => entry.address === run.out)?.label).sort();
        assert.deepEqual(labels, Array.from({ length: PROCESSES }, (_unused, n) => `deposit-${n}`));
        assert.equal(fs.existsSync(`${WalletPath()}.lock`), false);
    });

    it('writes the network it learned from the mirror into the file', async () => {
        setNetwork('testnet');
        assert.equal(Network(), 'testnet');
        assert.throws(() => setNetwork('moonnet'), /Unknown network/);
        const exported = JSON.parse(await HDWallet.getInstance().exportEncrypted(PASSWORD));
        assert.equal(exported.network, 'testnet');
        assert.equal(exported.kdf, 'scrypt');
        setNetwork('devnet');
    });

    it('changes the password and exports the phrase only with the right one', async () => {
        // The wallet logs the refused passwords and every phrase export to standard error: the lines are collected here and checked, not printed among the test results
        const logged: string[] = [];
        const originalError = console.error;
        console.error = (message?: unknown) => { logged.push(String(message)); };
        try {
            await HDWallet.changePassword(PASSWORD, 'Second-Password#2026');
            await assert.rejects(HDWallet.changePassword(PASSWORD, 'Third-Password#2026'), /Invalid current password/);
            HDWallet.clearSession();
            const wallet = await HDWallet.initialize('Second-Password#2026');
            assert.deepEqual(await wallet.exportMnemonic('Second-Password#2026'), MNEMONIC.split(' '));
            await assert.rejects(wallet.exportMnemonic(PASSWORD), /Invalid password/);
        } finally {
            console.error = originalError;
        }
        assert.deepEqual(logged.map(entry => entry.split(' {')[0]), [
            '[error] Failed to decrypt wallet with current password',
            '[warn] Exporting mnemonic phrase - handle with extreme care',
            '[warn] Exporting mnemonic phrase - handle with extreme care',
            '[error] Failed to export mnemonic'
        ]);
    });
});
