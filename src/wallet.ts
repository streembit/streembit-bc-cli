// Streembit HD Wallet, client edition
//
// An HD wallet (BIP-39 + BIP-32 + BIP-44) whose keys, addresses, file format and metadata rules come
// from streembit-bc-sdk. This class adds what is specific to the CLI: the wallet file under the data
// directory, the singleton session, and balances read from the read mirror's public API through the
// SDK's client. It is the node's wallet/Wallet.ts with the node's storage replaced by the mirror's API.
//
// BIP-44 Path: m/44'/19640701'/<account>'/0/<address>
//   - 19640701: Streembit coin type (unregistered)
//   - change is always 0 (no change addresses in account model)
//

import {
    generateMnemonic, validateMnemonic, normalizeMnemonic, seedFromMnemonic, deriveFromSeed,
    createWalletFile, openWalletFile, changeWalletPassword, validatePassword,
    trackedAccounts, knownAddressIndexes, addressSearchBound, withNextAddress, withAddressLabel, addressLabel
} from 'streembit-bc-sdk';
import type { WalletData, WalletMetadata } from 'streembit-bc-sdk';
import { fetchAccount } from 'streembit-bc-sdk/api';
import type { AccountInfo } from 'streembit-bc-sdk/api';
import { AssetId } from 'streembit-bc-types';
import Decimal from 'decimal.js';
import { Network, WalletPath } from './config';
import { logger } from './log';
import { writeJsonToFile, readJsonFromFile, fileExists, ensureDir, withFileLock, keepReplacedCopy } from './files';
import * as path from 'node:path';

export class HDWallet {
    // Singleton instance
    private static instance: HDWallet | null = null;
    private static currentPassword: string | null = null;

    private readonly mnemonic: string;
    private readonly seed: Uint8Array;
    private walletPath?: string;  // Store the wallet file path
    private walletMetadata?: WalletMetadata;  // Cache metadata

    // Make constructor private to enforce singleton pattern
    private constructor(mnemonic?: string, passphrase: string = '') {
        if (mnemonic) {
            if (!validateMnemonic(mnemonic)) {
                throw new Error('Invalid mnemonic phrase');
            }
            // the canonical form, as the wallet file stores it
            this.mnemonic = normalizeMnemonic(mnemonic);
        } else {
            this.mnemonic = generateMnemonic(); // 12 words
        }

        this.seed = seedFromMnemonic(this.mnemonic, passphrase); // 64 bytes
    }

    /**
     * Initialize wallet singleton (load from file)
     * @param password Password to decrypt the wallet
     * @param filepath Optional custom filepath (defaults to the data directory's wallet.json)
     * @param passphrase Optional BIP39 passphrase for seed generation
     * @returns HDWallet singleton instance
     */
    static async initialize(
        password: string,
        filepath?: string,
        passphrase: string = ''
    ): Promise<HDWallet> {
        // If already initialized, return existing instance
        if (HDWallet.instance && HDWallet.currentPassword) {
            logger.debug('Wallet already initialized, returning existing instance');
            return HDWallet.instance;
        }

        logger.debug('Initializing wallet singleton');

        // Load wallet from file
        const wallet = await HDWallet.loadFromFileInternal(password, filepath, passphrase);

        // Store instance and password
        HDWallet.instance = wallet;
        HDWallet.currentPassword = password;

        logger.debug('Wallet singleton initialized successfully');
        return wallet;
    }

    /**
     * Create a new wallet singleton
     * Used for wallet-create command
     * @param password Password to encrypt the wallet
     * @param mnemonic Optional mnemonic (if not provided, generates new one)
     * @param passphrase Optional BIP39 passphrase
     * @returns HDWallet singleton instance
     */
    static async createNew(
        password: string,
        mnemonic?: string,
        passphrase: string = ''
    ): Promise<HDWallet> {
        logger.debug('Creating new wallet singleton');

        const validation = validatePassword(password);
        if (!validation.isValid) {
            throw new Error(validation.error);
        }

        // Create new wallet instance
        const wallet = new HDWallet(mnemonic, passphrase);

        // Store instance and password
        HDWallet.instance = wallet;
        HDWallet.currentPassword = password;

        logger.info('New wallet singleton created successfully');
        return wallet;
    }

    /**
     * Get the current wallet singleton instance
     * @throws Error if wallet is not initialized
     * @returns HDWallet instance
     */
    static getInstance(): HDWallet {
        if (!HDWallet.instance) {
            throw new Error('Wallet not initialized. Call HDWallet.initialize() or HDWallet.createNew() first.');
        }
        return HDWallet.instance;
    }

    /**
     * Check if wallet is authenticated (instance exists with password)
     * @returns True if wallet is initialized and authenticated
     */
    static isAuthenticated(): boolean {
        return HDWallet.instance !== null && HDWallet.currentPassword !== null && HDWallet.currentPassword.length > 0;
    }

    /**
     * Clear the wallet singleton session
     * Removes instance and password from memory
     */
    static clearSession(): void {
        logger.info('Clearing wallet session');
        HDWallet.instance = null;
        HDWallet.currentPassword = null;
    }

    getMnemonic(): string {
        return this.mnemonic;
    }

    getAccount(
        accountIndex: number = 0,
        addressIndex: number = 0
    ): {
        path: string;
        privateKey: string;   // hex
        publicKey: string;    // compressed hex
        address: string;      // Streembit address (Base58Check with 'S' prefix)
    } {
        try {
            return deriveFromSeed(this.seed, accountIndex, addressIndex);
        } catch (error) {
            logger.error('Failed to derive account', { accountIndex, addressIndex, error });
            throw error;
        }
    }

    /**
     * Balance and sequence of an account's address, from the read mirror
     * @param accountIndex HD account index
     * @param addressIndex HD address index
     * @returns The mirror's account record: address, SBRIT balance, current sequence
     */
    async getAccountInfo(accountIndex: number, addressIndex: number): Promise<AccountInfo> {
        const account = this.getAccount(accountIndex, addressIndex);
        logger.debug('Fetching account from the read mirror', { accountIndex, addressIndex, address: account.address });
        return fetchAccount(account.address);
    }

    /**
     * Get all balances for an account
     * The public API answers the SBRIT balance; the map has that one entry
     * @param accountIndex HD account index
     * @param addressIndex HD address index
     * @returns Map of asset to balance
     */
    async getAccountBalances(
        accountIndex: number,
        addressIndex: number
    ): Promise<Map<string, string>> {
        try {
            const info = await this.getAccountInfo(accountIndex, addressIndex);
            return new Map([[AssetId.SBRIT, info.balance]]);
        } catch (error) {
            logger.error('Failed to fetch account balances', { accountIndex, addressIndex, error });
            throw error;
        }
    }

    /**
     * Check balance for specific asset
     * @param accountIndex HD account index
     * @param addressIndex HD address index
     * @param asset Asset to check; SBRIT in Phase 1
     * @returns Balance as decimal string
     */
    async checkBalance(
        accountIndex: number,
        addressIndex: number,
        asset: AssetId = AssetId.SBRIT
    ): Promise<string> {
        if (asset !== AssetId.SBRIT) {
            throw new Error(`Balances in ${asset} are not available`);
        }
        try {
            const info = await this.getAccountInfo(accountIndex, addressIndex);
            logger.debug('Balance retrieved', { address: info.address, asset, balance: info.balance });
            return info.balance;
        } catch (error) {
            logger.error('Failed to check balance', { accountIndex, addressIndex, asset, error });
            throw error;
        }
    }

    /**
     * List all known addresses tracked in wallet metadata
     * @returns Array of derived addresses with indices and optional labels
     */
    async listKnownAddresses(): Promise<Array<{
        accountIndex: number;
        addressIndex: number;
        address: string;
        path: string;
        label?: string;
    }>> {
        const metadata = await this.loadMetadata();

        const addresses: Array<{
            accountIndex: number;
            addressIndex: number;
            address: string;
            path: string;
            label?: string;
        }> = [];

        for (const { accountIndex, addressIndex } of knownAddressIndexes(metadata)) {
            const account = this.getAccount(accountIndex, addressIndex);
            addresses.push({
                accountIndex,
                addressIndex,
                address: account.address,
                path: account.path,
                label: addressLabel(metadata, account.address)
            });
        }

        return addresses;
    }

    /**
     * Aggregate balances across all known addresses
     * @returns Totals per asset and per-address breakdown
     */
    async aggregateBalances(): Promise<{
        totals: Map<string, string>;
        addresses: Array<{
            accountIndex: number;
            addressIndex: number;
            address: string;
            path: string;
            label?: string;
            balances: Map<string, string>;
        }>;
    }> {
        const knownAddresses = await this.listKnownAddresses();
        let total = new Decimal(0);
        const addressSummaries: Array<{
            accountIndex: number;
            addressIndex: number;
            address: string;
            path: string;
            label?: string;
            balances: Map<string, string>;
        }> = [];

        for (const entry of knownAddresses) {
            const info = await fetchAccount(entry.address);
            addressSummaries.push({
                ...entry,
                balances: new Map([[AssetId.SBRIT, info.balance]])
            });
            total = total.plus(info.balance);
        }

        return {
            totals: new Map([[AssetId.SBRIT, total.toString()]]),
            addresses: addressSummaries
        };
    }

    /**
     * Discover used addresses of account 0
     * Asks the read mirror for each address index in the range; an address is used when it holds a balance
     * or has sent a transaction (sequence above 0). The used addresses are recorded as tracked in the wallet file
     * @param startIndex Starting address index
     * @param limit Maximum number of addresses to check
     * @returns Array of used addresses with their balances
     */
    async discoverAccounts(
        startIndex: number = 0,
        limit: number = 20
    ): Promise<Array<{
        index: number;
        address: string;
        balances: Map<string, string>;
        sequence: number;
    }>> {
        try {
            logger.debug('Starting account discovery', { startIndex, limit });

            const accounts = [];

            for (let i = startIndex; i < startIndex + limit; i++) {
                const account = this.getAccount(0, i); // Account 0, address index i
                const info = await fetchAccount(account.address);

                if (new Decimal(info.balance).gt(0) || info.sequence > 0) {
                    logger.debug('Found used address', { index: i, address: account.address, balance: info.balance, sequence: info.sequence });
                    accounts.push({
                        index: i,
                        address: account.address,
                        balances: new Map([[AssetId.SBRIT, info.balance]]),
                        sequence: info.sequence
                    });
                }
            }

            // Record what was found: the tracked range of account 0 is extended to the highest used address, keeping
            // its label, so that the wallet's total and its address list include the discovered addresses
            if (accounts.length > 0) {
                const highest = accounts[accounts.length - 1];
                await this.changeMetadata(metadata => withAddressLabel(metadata, highest.address, addressLabel(metadata, highest.address), 0, highest.index));
            }

            logger.debug('Account discovery completed', { startIndex, limit, foundAccounts: accounts.length });

            return accounts;
        } catch (error) {
            logger.error('Failed to discover accounts', { startIndex, limit, error });
            throw error;
        }
    }

    /**
     * Get default wallet file path
     * @returns Path to wallet.json in the data directory
     */
    private static getDefaultWalletPath(): string {
        return WalletPath();
    }

    /**
     * Save wallet to encrypted file
     * @param password Password to encrypt the wallet
     * @param filepath Optional custom filepath (defaults to the data directory's wallet.json)
     * @returns The path of the copy kept of a wallet file this one replaced, or null when there was none
     */
    async saveToFile(password: string, filepath?: string): Promise<string | null> {
        try {
            const walletPath = filepath || HDWallet.getDefaultWalletPath();
            const walletDir = path.dirname(walletPath);

            logger.debug('Saving wallet to file', { path: walletPath });

            // Ensure wallet directory exists
            await ensureDir(walletDir);

            // The SDK validates the password and the phrase and seals the file
            const walletData = await createWalletFile(this.mnemonic, password, { network: Network(), metadata: {} });

            // Write to file, under the wallet file lock: not in the middle of another process's change to the file it
            // replaces. A wallet file that is already there holds another recovery phrase: it is never lost to a
            // new wallet, a copy of it is kept beside the new file
            const replaced = await withFileLock(walletPath, async () => {
                const copy = await keepReplacedCopy(walletPath);
                await writeJsonToFile(walletPath, walletData);
                return copy;
            });

            // Store the path for future operations
            this.walletPath = walletPath;

            logger.info('Wallet saved successfully', { path: walletPath, replaced });
            return replaced;
        } catch (error) {
            logger.debug('Failed to save wallet', { error });
            throw error;
        }
    }

    /**
     * Internal method to load wallet from encrypted file (does not set singleton)
     * @param password Password to decrypt the wallet
     * @param filepath Optional custom filepath (defaults to the data directory's wallet.json)
     * @param passphrase Optional BIP39 passphrase for seed generation
     * @returns HDWallet instance
     */
    private static async loadFromFileInternal(
        password: string,
        filepath?: string,
        passphrase: string = ''
    ): Promise<HDWallet> {
        const walletPath = filepath || HDWallet.getDefaultWalletPath();

        logger.debug('Loading wallet from file', { path: walletPath });

        // Read wallet file; the SDK checks the password policy, the version and the key derivation
        const walletData: WalletData = await readJsonFromFile(walletPath);
        const mnemonic = await openWalletFile(walletData, password);

        // Create wallet instance
        const wallet = new HDWallet(mnemonic, passphrase);

        // Set the wallet path for future operations
        wallet.setWalletPath(walletPath);

        logger.info('Wallet loaded successfully', { network: walletData.network, createdAt: walletData.createdAt });

        return wallet;
    }

    /**
     * Change the password used to encrypt the wallet file
     * @param currentPassword Existing password
     * @param newPassword New password
     * @param filepath Optional custom filepath
     */
    static async changePassword(
        currentPassword: string,
        newPassword: string,
        filepath?: string
    ): Promise<void> {
        const walletPath = filepath || HDWallet.getDefaultWalletPath();

        // Read, re-encrypt and write under the wallet file lock: an address or a label another process records meanwhile is not lost
        await withFileLock(walletPath, async () => {
            const walletData: WalletData = await readJsonFromFile(walletPath);

            let updated: WalletData;
            try {
                updated = await changeWalletPassword(walletData, currentPassword, newPassword);
            } catch (error) {
                if (error instanceof Error && error.message.includes('Decryption failed')) {
                    logger.error('Failed to decrypt wallet with current password', { error });
                    throw new Error('Invalid current password');
                }
                throw error;
            }

            await writeJsonToFile(walletPath, updated);
        });

        logger.info('Wallet password changed successfully', { path: walletPath });
    }

    /**
     * Check if wallet file exists
     * @param filepath Optional custom filepath
     * @returns True if wallet file exists
     */
    static async exists(filepath?: string): Promise<boolean> {
        try {
            const walletPath = filepath || HDWallet.getDefaultWalletPath();
            return await fileExists(walletPath);
        } catch {
            return false;
        }
    }

    /**
     * What the wallet file says about itself, read without the password
     * @param filepath Optional custom filepath
     * @returns Path, file version, network, creation time and the number of tracked addresses
     */
    static async fileInfo(filepath?: string): Promise<{ path: string; version: number; network: string; createdAt: string; addressCount: number }> {
        const walletPath = filepath || HDWallet.getDefaultWalletPath();
        const walletData: WalletData = await readJsonFromFile(walletPath);
        return { path: walletPath, version: walletData.version, network: walletData.network, createdAt: walletData.createdAt, addressCount: knownAddressIndexes(walletData.metadata).length };
    }

    /**
     * Copy the wallet file, as it is, to a backup file: still encrypted under the wallet's password, with its
     * labels and tracked addresses. An existing destination is never overwritten
     * @param destination Path of the backup file
     * @param filepath Optional custom wallet filepath
     * @returns The absolute path written
     */
    static async backupTo(destination: string, filepath?: string): Promise<string> {
        const walletPath = filepath || HDWallet.getDefaultWalletPath();
        const target = path.resolve(process.cwd(), destination);
        if (await fileExists(target)) {
            throw new Error(`${target} already exists; a backup never overwrites a file`);
        }
        const walletData: WalletData = await readJsonFromFile(walletPath);
        await writeJsonToFile(target, walletData);
        logger.info('Wallet backup written', { path: target });
        return target;
    }

    /**
     * Install a backup file as the wallet file, after checking that it opens with its password. The file keeps
     * its password, labels and tracked addresses; the open session is closed
     * @param source Path of the backup file
     * @param password Password of the backup
     * @param filepath Optional custom wallet filepath
     * @returns The path of the copy kept of the wallet file the backup replaced, or null when there was none
     */
    static async installBackup(source: string, password: string, filepath?: string): Promise<string | null> {
        const walletPath = filepath || HDWallet.getDefaultWalletPath();
        const walletData: WalletData = await readJsonFromFile(path.resolve(process.cwd(), source));
        await openWalletFile(walletData, password);
        const replaced = await withFileLock(walletPath, async () => {
            const copy = await keepReplacedCopy(walletPath);
            await writeJsonToFile(walletPath, walletData);
            return copy;
        });
        HDWallet.clearSession();
        logger.info('Wallet backup installed', { path: walletPath, replaced });
        return replaced;
    }

    /**
     * Export wallet data for backup (still encrypted)
     * @returns Encrypted wallet data as JSON string
     */
    async exportEncrypted(password: string): Promise<string> {
        try {
            const exportData = await createWalletFile(this.mnemonic, password, { network: Network() });
            return JSON.stringify(exportData, null, 2);
        } catch (error) {
            logger.error('Failed to export wallet', { error });
            throw error;
        }
    }

    /**
     * Export mnemonic phrase (requires password verification)
     * This is a security-sensitive operation that returns the wallet's seed phrase
     * @param password Password to verify wallet ownership
     * @param filepath Optional custom filepath (defaults to loaded wallet path)
     * @returns Array of mnemonic words
     */
    async exportMnemonic(password: string, filepath?: string): Promise<string[]> {
        try {
            const walletPath = filepath || this.walletPath || HDWallet.getDefaultWalletPath();

            logger.warn('Exporting mnemonic phrase - handle with extreme care', { path: walletPath });

            // Read and decrypt wallet to verify password
            const walletData: WalletData = await readJsonFromFile(walletPath);
            const mnemonic = await openWalletFile(walletData, password);

            // Verify the decrypted mnemonic matches this wallet's mnemonic
            if (mnemonic !== this.mnemonic) {
                throw new Error('Password verification failed');
            }

            // Return mnemonic as array of words
            return this.mnemonic.split(' ');
        } catch (error) {
            logger.error('Failed to export mnemonic', { error });
            if (error instanceof Error && error.message.includes('Decryption failed')) {
                throw new Error('Invalid password');
            }
            throw error;
        }
    }

    /**
     * Load metadata from wallet file
     * @param filepath Optional custom filepath
     * @returns Wallet metadata
     */
    private async loadMetadata(filepath?: string): Promise<WalletMetadata> {
        try {
            const walletPath = filepath || this.walletPath || HDWallet.getDefaultWalletPath();
            const walletData: WalletData = await readJsonFromFile(walletPath);
            this.walletMetadata = walletData.metadata || {};
            return this.walletMetadata;
        } catch (error) {
            logger.error('Failed to load metadata', { error });
            // Return empty metadata if file doesn't exist or error
            return {};
        }
    }

    /**
     * Change the metadata in the wallet file while preserving the encrypted data. The file is read, changed and
     * written back under the wallet file lock, so that another streembit-cli process cannot change it in between:
     * the change is always applied to what the file holds now, never to a copy read earlier. A file that cannot
     * be read is an error here, never empty metadata, because the result is written back
     * @param change Returns the new metadata from the metadata the file holds
     * @param filepath Optional custom filepath
     */
    private async changeMetadata(change: (metadata: WalletMetadata) => WalletMetadata, filepath?: string): Promise<void> {
        const walletPath = filepath || this.walletPath || HDWallet.getDefaultWalletPath();
        try {
            await withFileLock(walletPath, async () => {
                const walletData: WalletData = await readJsonFromFile(walletPath);
                const metadata = change(walletData.metadata || {});
                walletData.metadata = metadata;
                await writeJsonToFile(walletPath, walletData);
                this.walletMetadata = metadata;
            });
            logger.debug('Metadata updated successfully', { path: walletPath });
        } catch (error) {
            logger.error('Failed to update metadata', { error });
            throw error;
        }
    }

    /**
     * Set or clear a label for a specific address
     * @param address Wallet address
     * @param label Optional label (omit or empty to remove)
     * @param accountIndex Optional account index to ensure metadata tracking
     * @param addressIndex Optional address index to ensure metadata tracking
     */
    async setAddressLabel(
        address: string,
        label?: string,
        accountIndex?: number,
        addressIndex?: number
    ): Promise<void> {
        await this.changeMetadata(metadata => withAddressLabel(metadata, address, label, accountIndex, addressIndex));
    }

    /**
     * Get the next available address for an account
     * Automatically tracks the last used index to prevent address reuse
     * @param accountIndex HD account index (default: 0)
     * @param label Optional label for the address
     * @returns Object containing the new address, its index, and account details
     */
    async getNextAddress(
        accountIndex: number = 0,
        label?: string
    ): Promise<{
        address: string;
        index: number;
        path: string;
        accountIndex: number;
        label?: string;
    }> {
        try {
            logger.debug('Getting next address for account', { accountIndex, hasLabel: !!label });

            // The next index is taken and recorded in one step under the wallet file lock, from what the file holds
            // at that moment: two processes asking at the same time get two different addresses
            let taken: { addressIndex: number; address: string; path: string } | undefined;
            await this.changeMetadata(metadata => {
                const next = withNextAddress(metadata, accountIndex);
                const derived = this.getAccount(accountIndex, next.addressIndex);
                taken = { addressIndex: next.addressIndex, address: derived.address, path: derived.path };
                return label ? withAddressLabel(next.metadata, derived.address, label) : next.metadata;
            });
            if (!taken) {
                throw new Error('The next address was not recorded in the wallet file');
            }
            const next = { addressIndex: taken.addressIndex };
            const account = { address: taken.address, path: taken.path };

            logger.info('New address generated', { accountIndex, addressIndex: next.addressIndex, address: account.address, label });

            const result: {
                address: string;
                index: number;
                path: string;
                accountIndex: number;
                label?: string;
            } = {
                address: account.address,
                index: next.addressIndex,
                path: account.path,
                accountIndex
            };

            if (label) {
                result.label = label;
            }

            return result;
        } catch (error) {
            logger.error('Failed to get next address', { accountIndex, error });
            throw error;
        }
    }

    /**
     * Get label for an address
     * @param address The address to get the label for
     * @returns The label or undefined if not set
     */
    async getAddressLabel(address: string): Promise<string | undefined> {
        try {
            const metadata = await this.loadMetadata();
            return addressLabel(metadata, address);
        } catch (error) {
            logger.error('Failed to get address label', { address, error });
            return undefined;
        }
    }

    /**
     * Get account details by address
     * Searches each tracked account up to its last tracked index plus the gap limit
     * @param targetAddress The address to search for
     * @returns Account details or null if not found
     */
    async getAccountByAddress(targetAddress: string): Promise<{
        path: string;
        privateKey: string;
        publicKey: string;
        address: string;
        accountIndex: number;
        addressIndex: number;
    } | null> {
        try {
            logger.debug('Searching for account by address', { targetAddress });

            const metadata = await this.loadMetadata();

            for (const accountIndex of trackedAccounts(metadata)) {
                const maxIndex = addressSearchBound(metadata, accountIndex);

                for (let addressIndex = 0; addressIndex <= maxIndex; addressIndex++) {
                    const account = this.getAccount(accountIndex, addressIndex);

                    if (account.address === targetAddress) {
                        logger.debug('Address found', { accountIndex, addressIndex, path: account.path });

                        return {
                            ...account,
                            accountIndex,
                            addressIndex
                        };
                    }
                }
            }

            logger.debug('Address not found in wallet', { targetAddress });
            return null;

        } catch (error) {
            logger.error('Failed to get account by address', { targetAddress, error });
            throw new Error(`Failed to get account by address for ${targetAddress} error: ${(error as Error).message}`);
        }
    }

    /**
     * Set the wallet file path (used after loading from file)
     * @param filepath The wallet file path
     */
    private setWalletPath(filepath: string): void {
        this.walletPath = filepath;
    }

    /**
     * Create a temporary wallet instance for testing purposes ONLY
     * This bypasses the singleton pattern and should NEVER be used in production
     * @internal
     */
    static __createForTesting(mnemonic?: string, passphrase: string = ''): HDWallet {
        return new HDWallet(mnemonic, passphrase);
    }
}
