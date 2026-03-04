import { Account, RpcProvider, hash, type Call } from 'starknet'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredAsset {
  asset_address: string
  asset_type: 'ERC20' | 'ERC721' | 'ERC1155' | 'ERC4626'
  value: string
  token_id: string
}

interface OrderData {
  borrower: string
  debtAssets: StoredAsset[]
  interestAssets: StoredAsset[]
  collateralAssets: StoredAsset[]
  duration: string
  deadline: string
  multiLender: boolean
  nonce: string
  debtHash: string
  interestHash: string
  collateralHash: string
  orderHash: string
}

interface OrderRow {
  id: string
  status: string
  order_data: string
  borrower_signature: string
}

interface OfferRow {
  lender: string
  bps: string
  nonce: string
  lender_signature: string
  lender_commitment: string
}

interface OrderDetail {
  order: OrderRow
  offers: OfferRow[]
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    console.error(`Missing required environment variable: ${name}`)
    process.exit(1)
  }
  return val
}

const RPC_URL = requiredEnv('RPC_URL')
const RELAYER_PRIVATE_KEY = requiredEnv('RELAYER_PRIVATE_KEY')
const RELAYER_ADDRESS = requiredEnv('RELAYER_ADDRESS')
const STELA_API_URL = requiredEnv('STELA_API_URL').replace(/\/$/, '')
const STELA_ADDRESS = requiredEnv('STELA_ADDRESS')
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '120000', 10)

// ---------------------------------------------------------------------------
// StarkNet setup
// ---------------------------------------------------------------------------

const provider = new RpcProvider({ nodeUrl: RPC_URL })
const account = new Account({
  provider,
  address: RELAYER_ADDRESS,
  signer: RELAYER_PRIVATE_KEY,
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ASSET_TYPE_ENUM: Record<string, number> = {
  ERC20: 0,
  ERC721: 1,
  ERC1155: 2,
  ERC4626: 3,
}

const NONCES_SELECTOR = hash.getSelectorFromName('nonces')

const U128_MASK = (1n << 128n) - 1n

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function toU256(value: string): [string, string] {
  const bn = BigInt(value)
  const low = bn & U128_MASK
  const high = bn >> 128n
  return ['0x' + low.toString(16), '0x' + high.toString(16)]
}

function serializeAssetCalldata(assets: StoredAsset[]): string[] {
  const parts: string[] = [assets.length.toString()]
  for (const asset of assets) {
    parts.push(asset.asset_address)
    parts.push(ASSET_TYPE_ENUM[asset.asset_type].toString())
    const [valueLow, valueHigh] = toU256(asset.value)
    parts.push(valueLow, valueHigh)
    const [tokenIdLow, tokenIdHigh] = toU256(asset.token_id)
    parts.push(tokenIdLow, tokenIdHigh)
  }
  return parts
}

function parseSig(sig: string): [string, string] {
  // Signature stored as JSON array or comma-separated "r,s"
  try {
    const parsed = JSON.parse(sig)
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return [String(parsed[0]), String(parsed[1])]
    }
  } catch {
    // not JSON
  }
  const parts = sig.split(',')
  if (parts.length >= 2) {
    return [parts[0].trim(), parts[1].trim()]
  }
  throw new Error(`Invalid signature format: ${sig}`)
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchMatchedOrders(): Promise<OrderRow[]> {
  const url = `${STELA_API_URL}/api/orders?status=matched`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch matched orders: ${res.status} ${res.statusText}`)
  }
  const data = (await res.json()) as { orders: OrderRow[] }
  return data.orders ?? []
}

async function fetchOrderDetail(orderId: string): Promise<OrderDetail> {
  const url = `${STELA_API_URL}/api/orders/${encodeURIComponent(orderId)}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch order ${orderId}: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as OrderDetail
}

// ---------------------------------------------------------------------------
// Nonce validation
// ---------------------------------------------------------------------------

async function getOnChainNonce(address: string): Promise<bigint> {
  try {
    const result = await provider.callContract({
      contractAddress: STELA_ADDRESS,
      entrypoint: 'nonces',
      calldata: [address],
    })
    return BigInt(result[0])
  } catch (err) {
    console.warn(`Failed to read nonce for ${address}:`, err)
    return -1n
  }
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

async function settleOrder(order: OrderRow, detail: OrderDetail): Promise<void> {
  let orderData: OrderData
  try {
    orderData = JSON.parse(detail.order.order_data)
  } catch (err) {
    console.error(`Order ${order.id}: failed to parse order_data, skipping:`, err)
    return
  }

  const offer = detail.offers[0]
  if (!offer) {
    console.warn(`Order ${order.id}: no offers found, skipping`)
    return
  }

  // Validate nonces (parallel)
  const [borrowerNonce, lenderNonce] = await Promise.all([
    getOnChainNonce(orderData.borrower),
    getOnChainNonce(offer.lender),
  ])

  if (borrowerNonce >= 0n && BigInt(orderData.nonce) !== borrowerNonce) {
    console.warn(`Order ${order.id}: borrower nonce mismatch (expected ${borrowerNonce}, got ${orderData.nonce}), skipping`)
    return
  }

  if (lenderNonce >= 0n && BigInt(offer.nonce) !== lenderNonce) {
    console.warn(`Order ${order.id}: lender nonce mismatch (expected ${lenderNonce}, got ${offer.nonce}), skipping`)
    return
  }

  // Build calldata
  const calldata: string[] = []

  // InscriptionOrder: 11 fields
  calldata.push(
    orderData.borrower,
    orderData.debtHash,
    orderData.interestHash,
    orderData.collateralHash,
    orderData.debtAssets.length.toString(),
    orderData.interestAssets.length.toString(),
    orderData.collateralAssets.length.toString(),
    orderData.duration,
    orderData.deadline,
    orderData.multiLender ? '1' : '0',
    orderData.nonce,
  )

  // Serialized asset arrays
  calldata.push(...serializeAssetCalldata(orderData.debtAssets))
  calldata.push(...serializeAssetCalldata(orderData.interestAssets))
  calldata.push(...serializeAssetCalldata(orderData.collateralAssets))

  // Borrower signature [len, r, s]
  const [borrowerR, borrowerS] = parseSig(detail.order.borrower_signature)
  calldata.push('2', borrowerR, borrowerS)

  // LendOffer: 6 fields
  const [bpsLow, bpsHigh] = toU256(offer.bps)
  calldata.push(
    orderData.orderHash,
    offer.lender,
    bpsLow,
    bpsHigh,
    offer.nonce,
    offer.lender_commitment || '0',
  )

  // Lender signature [len, r, s]
  const [lenderR, lenderS] = parseSig(offer.lender_signature)
  calldata.push('2', lenderR, lenderS)

  // Execute settle()
  const call: Call = {
    contractAddress: STELA_ADDRESS,
    entrypoint: 'settle',
    calldata,
  }

  console.log(`Order ${order.id}: submitting settle() transaction...`)
  const tx = await account.execute([call])
  console.log(`Order ${order.id}: tx submitted, hash=${tx.transaction_hash}`)

  // Wait for confirmation
  const receipt = await provider.waitForTransaction(tx.transaction_hash)
  console.log(`Order ${order.id}: confirmed in block ${(receipt as any).block_number ?? 'unknown'}`)
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let running = true
let isPollInProgress = false

async function poll(): Promise<void> {
  try {
    console.log(`[${new Date().toISOString()}] Polling for matched orders...`)
    const orders = await fetchMatchedOrders()

    if (orders.length === 0) {
      console.log('No matched orders found.')
      return
    }

    console.log(`Found ${orders.length} matched order(s).`)

    for (const order of orders) {
      if (!running) break
      try {
        const detail = await fetchOrderDetail(order.id)
        await settleOrder(order, detail)
      } catch (err) {
        console.error(`Error settling order ${order.id}:`, err)
      }
    }
  } catch (err) {
    console.error('Error during poll:', err)
  }
}

async function main(): Promise<void> {
  console.log('Stela Relayer starting...')
  console.log(`  RPC:      ${RPC_URL.replace(/\/[^/]+$/, '/***')}`)
  console.log(`  API:      ${STELA_API_URL}`)
  console.log(`  Contract: ${STELA_ADDRESS}`)
  console.log(`  Relayer:  ${RELAYER_ADDRESS}`)
  console.log(`  Interval: ${POLL_INTERVAL_MS}ms`)
  console.log('')

  // Initial poll
  await poll()

  // Scheduled polling
  const interval = setInterval(async () => {
    if (!running || isPollInProgress) return
    isPollInProgress = true
    try {
      await poll()
    } finally {
      isPollInProgress = false
    }
  }, POLL_INTERVAL_MS)

  // Graceful shutdown
  const shutdown = () => {
    if (!running) return
    console.log('\nShutting down gracefully...')
    running = false
    clearInterval(interval)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
