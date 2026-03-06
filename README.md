# Stela Relayer

A standalone relayer that settles matched P2P lending orders on StarkNet for the [Stela protocol](https://stela-dapp.xyz).

## What is a Stela Relayer?

Stela is a peer-to-peer lending protocol on StarkNet. Borrowers create loan inscriptions (off-chain signed orders) specifying debt, interest, and collateral assets. Lenders browse these orders and sign matching offers.

A **relayer** watches for matched orders (an order paired with a signed lender offer) and submits the `settle()` transaction on-chain. The relayer pays gas but earns a fee for the service.

### Fee Economics

Every settlement charges a **20 BPS (0.20%) protocol fee** on each debt asset:

| Recipient | Share | Description |
|-----------|-------|-------------|
| **Relayer** | **5 BPS** | Settlement reward (paid to `msg.sender`) |
| Treasury | 15 BPS | Protocol revenue |

Genesis NFT holders receive on-chain fee discounts (up to 50% off the treasury portion).

The relayer fee is paid in the debt asset token(s), automatically by the contract. You earn 5 BPS of every debt asset on every settlement you execute.

### How settle() Works

1. Relayer calls `settle(order, debt_assets, interest_assets, collateral_assets, borrower_sig, offer, lender_sig)`
2. Contract verifies both SNIP-12 signatures (borrower's InscriptionOrder + lender's LendOffer)
3. Contract validates nonces, deadlines, and asset hashes
4. Debt assets transfer from lender to borrower (minus fees)
5. Collateral assets lock in the contract
6. Interest assets are noted for repayment
7. ERC1155 shares are minted to the lender
8. Relayer receives 5 BPS fee automatically

## Setup

### Prerequisites

- Node.js 22+
- A StarkNet wallet with enough ETH/STRK for gas
- An RPC endpoint supporting v0.8 spec (for V3 transactions)

### Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | Yes | - | StarkNet RPC endpoint (v0.8 spec) |
| `RELAYER_PRIVATE_KEY` | Yes | - | Your relayer wallet private key |
| `RELAYER_ADDRESS` | Yes | - | Your relayer wallet address |
| `STELA_API_URL` | Yes | - | Stela API base URL |
| `STELA_ADDRESS` | Yes | - | Stela protocol contract address |
| `POLL_INTERVAL_MS` | No | `120000` | Poll interval in ms (2 minutes) |

### Running with Node.js

```bash
npm install
npm start          # runs with tsx (dev)
npm run build      # compile TypeScript
npm run start:built # run compiled JS
```

### Running with Docker

```bash
docker build -t stela-relayer .
docker run --env-file .env stela-relayer
```

## Architecture

```
Poll loop (every POLL_INTERVAL_MS)
  -> GET /api/orders?status=matched
  -> For each matched order:
     -> GET /api/orders/{id} (full order data + offers + signatures)
     -> Validate on-chain nonces
     -> Build settle() calldata
     -> Execute transaction via Account.execute
     -> Log result
```

The relayer is stateless. It relies entirely on the Stela API for order discovery and the StarkNet RPC for on-chain state. Multiple relayers can run concurrently -- the first to submit a valid settlement wins the fee.

## Related Repos

- [stela](https://github.com/fepvenancio/stela) - Cairo smart contracts
- [stela-sdk-ts](https://github.com/fepvenancio/stela-sdk-ts) - TypeScript SDK
- [stela-app](https://github.com/fepvenancio/stela-app) - Next.js frontend + workers

## License

MIT
