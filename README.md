# streembit-bc-cli

## What this package is for

Streembit is a blockchain with the native asset SBRIT. This package is its command line wallet: a program you run in a terminal to create a wallet, receive and send SBRIT, call smart contracts and look up balances, transactions and chain information. It is meant for people who work in a terminal and for services, such as an exchange or a payment system, that drive a wallet from scripts. Its commands follow the Bitcoin command line client where an equivalent exists, so an existing Bitcoin integration can be adapted with little change.

It is a client only. It runs no node and stores no chain data: it reads from a read mirror and sends signed transactions to the Accountable Node. The keys are created and kept on your machine in an encrypted wallet file, and transactions are signed there; a key or recovery phrase is never sent anywhere.

Use it if you want a Streembit wallet without a graphical interface, need to script payments, or operate an Accountable Node or a validator and take part in multisig requests. If you are building your own wallet or application, use `streembit-bc-sdk`, the library this program is built on.

## Overview

The Streembit CLI, the `streembit-cli` command: create or restore an HD wallet, receive and send SBRIT, call
contracts, and read balances, history, transactions and chain information. Every read goes to a read mirror's
public HTTP API; the Accountable Node receives signed transactions and the multisig requests, which it alone
keeps. Command names follow the
Bitcoin CLI where one exists, so an exchange integrates it the way it integrates `bitcoin-cli`. A client only:
no node, no database, no node identity. The keys never leave the machine.

- Wallet core and node API client: the `streembit-bc-sdk` package, which the node, the web wallet and the
  desktop wallet use as well. Addresses, the wallet file (`wallet.json`, scrypt and AES-256-GCM), the signing
  preimage, txids and signatures are produced by that one implementation; nothing is re-implemented here.
  Protocol constants come from `streembit-bc-types`.
- The wallet file opens in the web wallet and in the node's CLI, and theirs opens here, because all three use
  the SDK's format.

## Installation

Node 26 or later. Two ways to get the `streembit-cli` command.

**Install with npm.** npm puts the `streembit-cli` command on the PATH:

```bash
npm install -g streembit-bc-cli
streembit-cli
```

**Clone and build.** For development, or to run from a checkout:

```bash
git clone https://github.com/streembit/streembit-bc-cli.git
cd streembit-bc-cli
npm install
npm run build
node dist/index.js
```

`npm start` runs the same `node dist/index.js`. To have the `streembit-cli` command from the checkout as
well, run `npm link` once in the directory; `npm unlink -g streembit-bc-cli` removes it again.

## Configuration

| Variable          | Default                       | Purpose                                                         |
|-------------------|-------------------------------|-----------------------------------------------------------------|
| `READ_URL`        | none, required                | A read mirror's public API: every read goes there                |
| `NODE_URL`        | `http://127.0.0.1:8080`       | The Accountable Node's public API: transaction submission and multisig requests |
| `WALLET_PASSWORD` | unset                         | The wallet password, for running without a prompt                |
| `WALLET_DATA_DIR` | `<home>/.streembit/wallet`    | Where `wallet.json` is kept                                      |
| `STREEMBIT_DEBUG` | unset                         | `1` prints the wallet's debug log to stderr                      |

The CLI does not start without `READ_URL`: every command, `help` and `validateaddress` included, ends with
an error and exit code 1 until it is set. The network name written into a new wallet file is learned from
the mirror. When the mirror does not answer, the shell still starts, so a wallet can be opened and its
addresses shown offline; the chain commands then report the connection error. `wallet-create` and
`wallet-restore` need the mirror to answer: the wallet file records its network, and it is never a guessed one.

```bash
READ_URL=https://mirror.example.org NODE_URL=https://node.example.org streembit-cli
```

## One-shot and scripted use

Without arguments `streembit-cli` opens the interactive shell. With a command it runs that command and exits:

```bash
streembit-cli getblockcount
streembit-cli sendtoaddress SRecipientAddress 1.5 --yes     # WALLET_PASSWORD is set in the environment
```

Set `WALLET_PASSWORD` where the service's environment is configured (a systemd unit's environment file, a
container secret), not on the command line: a password typed there is kept in the shell history and shown in
the process list.

- Results go to stdout, errors and notes to stderr. The exit code is 0 on success, 1 when the command failed,
  and 130 when it was interrupted (Ctrl+C or an interrupt signal) while running or waiting for an answer.
- The wallet password is typed at the prompt, or taken from `WALLET_PASSWORD` when it is set. There is no
  password option on the command line.
- `sendtoaddress` and `contract-call-send` show a review and ask for confirmation; `--yes` skips both and
  prints the transaction id alone.
- `multisig-request` and `multisig-sign` ask for confirmation as well; `--yes` skips it, and
  `multisig-request --yes` prints the request id alone.
- `wallet-create`, `wallet-restore`, `wallet-mnemonic`, `wallet-import` and `walletpassphrasechange` need a
  terminal: the phrase and a new password are never taken from the environment.

## Commands

Command names follow the Bitcoin CLI where one exists, and the node's CLI otherwise, so the same command
means the same thing in both.

**Bitcoin CLI commands.** They print a bare value or JSON, as `bitcoin-cli` does.

| Command | What it does |
|---|---|
| `getblockcount` | the chain height |
| `getbestblockhash` | the hash of the tip block |
| `getblockchaininfo` | `chain`, `blocks`, `bestblockhash`, `chainid`, `version` |
| `getbalance` | the total SBRIT of the wallet's tracked addresses |
| `getnewaddress [label]` | the next unused address of account 0 |
| `validateaddress <address>` | `isvalid`, `address`, `iscontract`; opens no wallet and contacts no server |
| `getwalletinfo` | what the wallet file says about itself; no password needed |
| `setlabel <address> <label>` | label a wallet address; an empty label removes it |
| `sendtoaddress <to> <amount> [SBRIT] [--from <address>] [--yes]` | send from account 0, address 0, or from `--from` |
| `sendtoaddress <from> <to> SBRIT <amount> [--yes]` | the node CLI's form of the same |
| `listtransactions [label] [count] [skip]` | the wallet's history as a JSON array, oldest first: the newest `count` entries (default 10) after skipping the newest `skip`; `label` keeps the entries of the addresses with that label, `*` means all |
| `gettransaction <txid>` | `txid`, `amount`, `asset`, `blockheight`, `time`, `type`, `from`, `to`; a transaction the mirror has is final |
| `walletpassphrasechange` | change the wallet file's password, at the prompts |
| `backupwallet <file>` | copy the wallet file; never overwrites |

**Streembit wallet commands.**

| Command | What it does |
|---|---|
| `wallet-create` | a new wallet: twelve-word phrase shown once, password per the policy, file sealed into the data directory |
| `wallet-restore` | the same from an existing phrase |
| `wallet-show [account] [count]` | the wallet's addresses and derivation paths |
| `wallet-addresses` | the addresses tracked in the wallet file, with labels |
| `wallet-new-address [account] [--label <l>]` | the next unused address of an account |
| `wallet-discover [max_addresses]` | find the used addresses of the wallet and track them |
| `wallet-balance [account] [index]` | balance and sequence of a wallet address |
| `addressbalance <address>` | balance and sequence of any address |
| `wallet-transactions [account] [index] [--count <n>]` | the newest transactions of one wallet address, as a table |
| `wallet-mnemonic` | show the recovery phrase; the password is always typed |
| `wallet-export <file>` | the same as `backupwallet` |
| `wallet-import <backup file>` | install a backup as the wallet; it keeps the backup's password |
| `getchaininfo` | the chain, the read mirror and the node the wallet is connected to |
| `getnode [nodeId]` | the record of an Accountable Node as JSON: `nodeId`, `status`, `publicKeys`, `deposit` and the rest; without an id, the ids of the active Accountable Nodes |
| `getvalidator [validatorId]` | the record of a validator as JSON: `vid`, `status`, `publicKeys`, `deposit`, `joinedAt`, and `rewardaddress`, the owner of the deposit; without an id, the ids of the active validators |
| `help`, `exit` | the shell |

**Contract commands.**

| Command | What it does |
|---|---|
| `getcontract <contract_address>` | `cid`, `codehash`, `sandboxhash`, `location` of the contract's active version |
| `contract-call-send --contract <address> --method <name> [--from <address>] [--data <json\|file>] [--amount <n>] [--yes]` | review, confirm, sign and submit a contract call |

`getnode` and `getvalidator` read the records from the mirror's cell route, `/api/v1/cell`, and need a mirror
that serves the cells under `acnode/` and `validator/`.

The contract metadata is read from the mirror, as every read: `getcontract` and `contract-call-send` need a
mirror that serves `/api/v1/contracts/:cid`.

**Multisig commands.** A contract call that needs several signatures is parked at the Accountable Node, which
collects the signatures and submits the transaction when the threshold is reached.

| Command | What it does |
|---|---|
| `multisig-request --contract <address> --method <name> --data <json\|file> [--yes]` | review, confirm, sign as the sender and park the call; prints the request id |
| `multisig-pending [--status pending\|submitted\|expired\|stale]` | the requests in which the key is an authorised signer, in short form |
| `multisig-show --id <id>` | one request in full: the decoded parameters, and each signer with whether and when it signed |
| `multisig-sign --id <id> [--yes]` | show the request, confirm, sign it and upload the signature; prints the submission outcome when the threshold is reached |
| `multisig-tx-submit --id <id>` | retry the submission when the automatic one after the last signature failed |
| `multisig-watch [--stop]` | poll every 30 seconds and print new requests, new signatures and status changes |

- The key of `multisig-request`, `multisig-pending`, `multisig-sign` and `multisig-watch` is a wallet address,
  `--from <address>` or account 0, address 0 when left out, or `--key-env <NAME>`: an environment variable
  that holds a private key of 64 hex characters. `--key-env` is for a key that is in no wallet, such as the
  second registered key of an Accountable Node; it needs no wallet and no password. Set the variable where
  the environment is configured, not on the command line.
- The requests are kept by the Accountable Node alone, not on the chain, so these commands read and write
  them at `NODE_URL`. The sequence and the contract metadata of a new request are read from the mirror.
- The node parks a request only with its sender's signature, so `multisig-request` signs at once. A sender
  has one open request, and it expires one hour after it was built.
- A key change of an Accountable Node (`addKey`, `removeKey`) is sent with `multisig-request` from a registered key that the node does not use, not from the node's identity key; the first `addKey`, when the identity key is the only registered key, is the one exception.
- When the last signature arrives the node submits the transaction. `stale` means the sender's sequence
  moved in the meantime: request again. `failed` means the submission failed: retry with
  `multisig-tx-submit`.
- `multisig-sign` refuses a request whose transaction does not hash to the id it was asked for.
- `multisig-watch` runs in the background in the shell until `multisig-watch --stop`; run as a single
  command it runs until Ctrl+C.
- A transaction carries at most 3 signatures in Phase 1.

`listtransactions` reads the history of all tracked addresses of the wallet together, and needs a mirror
that serves `POST /api/v1/transactions/query`. An entry is one balance change of one wallet address, as the
chain recorded it, so a payment a contract made to an address is listed as well as a transfer, and a transfer
between two addresses of the wallet is two entries, a `send` and a `receive`. The fields of an entry:

| Field | Content |
|---|---|
| `address` | `receive`: the wallet address that received; `send`: the destination |
| `category` | by the sign of the amount: `send` when negative, `receive` when positive; a zero amount is a `send` for the sender of the transaction |
| `amount` | SBRIT with 8 decimals, as a string; negative for a `send`, without the fee |
| `label` | the label of `address`, when it is a wallet address that has one |
| `fee` | on the sender's entry: the fee the transaction paid, negative |
| `blockheight`, `blockindex` | the height of the block and the position of the transaction in it |
| `time` | the transaction's time, in seconds |
| `txid` | the transaction id |
| `type` | the transaction type, for example `transfer`, `mint` or `contract_call` |
| `method` | on a contract call: the method called |

There is no `confirmations` field: a block is final when written, and a transaction the mirror has is final.

When the mirror is a block behind and the node refuses a transaction's sequence, the transaction is signed
again with the sequence the node names and submitted once more.

The password policy is the SDK's: twelve characters with a lower-case letter, an upper-case letter, a digit
and a special character. The password is never stored; the twelve words are the wallet, the password guards
the file on this machine.

On Linux and macOS a new wallet file, and a backup of it, is created readable by its owner only (permissions
600), in a data directory created 700. A file that already exists keeps its permissions: a wallet created by
an earlier version is tightened with `chmod 600 wallet.json`.

## Known issues

- `listtransactions <label>` reads the whole history of the wallet from the mirror and filters it afterwards,
  so a label with few entries is slow on a wallet with a long history. The answer is correct. A faster filter
  is a feature for a later version.

## Development

```bash
npm install
npm run dev          # tsx src/index.ts
npm test             # node:test against a fake mirror and node
npm run build        # tsc to dist/
```

`streembit-bc-sdk` and `streembit-bc-types` are pinned in `package.json` to exact npm versions, the ones this
version of the CLI was built and tested against. To take a new version of either package: change the version
in `package.json`, run `npm install`, type-check and test.

## Licence

MIT. See [LICENSE](LICENSE).

## Layout

```
src/index.ts             entry point: configuration, command registration, one-shot mode, the shell
src/config.ts            READ_URL, NODE_URL, WALLET_DATA_DIR, the network name learned from the mirror
src/wallet.ts            the HD wallet: keys and file from the SDK, balances from the read mirror
src/files.ts             wallet file read and write
src/log.ts               the logger (silent unless STREEMBIT_DEBUG=1)
src/cli/shell.ts         command registry and REPL
src/cli/input.ts         prompts: text, hidden password, confirmation
src/cli/args.ts          argument parsing
src/cli/output.ts        printing
src/commands/wallet.ts   the wallet, chain and contract commands
src/commands/multisig.ts the multisig commands
src/commands/help.ts     help
src/commands/exit.ts     exit
tests/                   wallet and command tests against a fake mirror and node
```
