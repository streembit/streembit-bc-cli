/**
 * Configuration of the wallet CLI: four values, read from the environment with defaults.
 *
 *   NODE_URL         the Accountable Node's public API (rest.publicPort), default http://127.0.0.1:8080;
 *                    used for one thing only, the submission of a signed transaction
 *   READ_URL         required, a read mirror's public API: every read (status, balance, sequence, history,
 *                    transaction, contract) goes there; the CLI refuses to start without it, so that no read
 *                    reaches the node
 *   WALLET_DATA_DIR  where wallet.json lives, default <home>/.streembit/wallet
 *   network          the network name written into the wallet file, learned from the mirror's status and
 *                    kept here; not known until the mirror has answered, and a wallet is not created
 *                    before that, so that no wallet file carries a guessed network
 *
 * No node config file, no identity: the wallet is a client of the API and nothing else.
 */

import * as os from 'node:os';
import * as path from 'node:path';

export type NetworkName = 'devnet' | 'testnet' | 'mainnet';

const DEFAULT_NODE_URL = 'http://127.0.0.1:8080';

// The network name the read mirror gave; null until it has answered. There is no default: a name that was not
// learned from the mirror is never handed out, so it can never be written into a wallet file
let network: NetworkName | null = null;

export function NodeUrl(): string {
    return (process.env.NODE_URL || DEFAULT_NODE_URL).replace(/\/+$/, '');
}

/** The read mirror's address. The CLI does not run without one: every read goes to the mirror, never to the Accountable Node */
export function ReadUrl(): string {
    const configured = (process.env.READ_URL || '').trim().replace(/\/+$/, '');
    if (!configured) {
        throw new Error('READ_URL is not set. Set it to the public API of a read mirror: the CLI reads the chain from the mirror and never from the Accountable Node.');
    }
    return configured;
}

export function DataDir(): string {
    const configured = process.env.WALLET_DATA_DIR;
    if (configured) {
        return path.resolve(process.cwd(), configured);
    }
    return path.join(os.homedir(), '.streembit', 'wallet');
}

/** Path of the wallet file inside the data directory */
export function WalletPath(): string {
    return path.join(DataDir(), 'wallet.json');
}

/** The network name learned from the read mirror. Throws while it is not known, so that whatever asks for it, the wallet file writer first of all, never gets a guessed one */
export function Network(): NetworkName {
    if (network === null) {
        throw new Error('The network is not known: the read mirror has not answered yet, and a wallet file is not written with a guessed network.');
    }
    return network;
}

/** Set from the mirror's status; an unknown name is refused so a wallet file never carries one */
export function setNetwork(name: string): void {
    if (name !== 'devnet' && name !== 'testnet' && name !== 'mainnet') {
        throw new Error(`Unknown network name from the read mirror: ${name}`);
    }
    network = name;
}

/** True once the network name has been learned from the read mirror */
export function NetworkKnown(): boolean {
    return network !== null;
}
