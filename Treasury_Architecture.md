# Viva Maya Web3: Treasury Infrastructure & Tokenomics

## 1. Token Deployment Specifications

The core tokenomics rely on an **Isolated Mint + Centralized Game Bridge** model. We do not use cross-chain bridging contracts to avoid security risks and high gas fees. The Game Relay acts as the unified ledger.

*   **Total Supply:** 1,000,000,000 (1 Billion) `$VIVA`
*   **Chain Allocation (Minted across 3 chains):** 
    *   **Solana (Native SPL):** 334,000,000 `$VIVA` (Decimals: 6)
    *   **Base (ERC-20):** 333,000,000 `$VIVA` (Decimals: 18)
    *   **Sui (Native Coin):** 333,000,000 `$VIVA` (Decimals: 9)
*   **Tokenomics Distribution (The Pie):** 
    *   **Game Rewards (50% - 500M):** Custodied in the automated Game Relay Hot Wallets to pay out players cashing in their DB points.
    *   **Market Making & Liquidity (20% - 200M):** Dedicated supply to pair with Fiat ad-revenue to seed initial Decentralized Exchange (DEX) liquidity pools (Raydium/Aerodrome), and to deploy via Market Making bots (e.g., Hummingbot) to maintain price stability.
    *   **Founder & Team (15% - 150M):** Your controlled allocation for personal profit, equity, and strategic voting power. Stored in a Cold Wallet (Multi-sig).
    *   **Infrastructure & Marketing (15% - 150M):** Capital reserve designed to be slowly sold (TWAP - Time Weighted Average Price) into the market during high-volume periods to pay for Supabase, RPC nodes, ad campaigns, and development costs. 

## 2. Server-Side Treasury Architecture

The backend (Node.js/Edge Functions) manages the centralized ledger. When a user cashes out their in-game points, the backend orchestrates a real on-chain transaction from the Hot Wallet to the user's specified address.

### 2.1 Private Key & Signer Management

Raw private keys must **never** touch application code, `.env` files, or the database.

*   **Key Management Service (KMS):** Cryptographic keys are generated and stored inside AWS KMS, Google Cloud KMS, or HashiCorp Vault.
*   **EVM (Base):** AWS KMS natively supports `secp256k1` keys. Node.js constructs the raw Ethereum transaction and sends the hash to KMS. KMS returns the signature (`v, r, s`), which the backend then broadcasts. The private key never enters the server's memory.
*   **Sui:** Sui supports both `Ed25519` and `Secp256k1`/`Secp256r1`. By generating a `Secp256r1` (NIST P-256) or `Secp256k1` key in KMS, we can use standard cloud HSMs to sign Sui transactions securely.
*   **Solana:** If the chosen KMS lacks direct raw `Ed25519` support for Solana, we utilize HashiCorp Vault's transit secrets engine or a dedicated cloud HSM to handle Solana signing requests via a secured internal gRPC/REST API.
*   **Hot/Cold Separation:** 
    *   **Hot Wallets:** Managed by KMS, funded automatically but hold only a 24-48 hour buffer of tokens/gas.
    *   **Cold Wallets:** Secured by multi-sig (Safe on Base, Squads on Solana, Multi-Sig on Sui) requiring human thresholds to refill the hot wallets.

### 2.2 Gas Fees & Sponsored Transactions

To maintain a seamless Web2-like experience, the Treasury abstracts and pays all withdrawal gas fees.

*   **Solana:** Transaction fees are negligible. The Solana Hot Wallet simply holds a small amount of native SOL to cover the SPL token transfer fees.
*   **Sui (Sponsored Transactions):** Sui natively supports Sponsored Transactions. The user submits a withdrawal intent; the backend constructs the transaction, signs it as the gas payer (sponsor), and broadcasts it. The user pays zero gas.
*   **Base:** The Base Hot Wallet holds native ETH to pay for the ERC-20 transfer gas. Since all withdrawals originate from our Hot Wallet, a standard funded EOA (secured by KMS) is sufficient and cheaper than full ERC-4337 Account Abstraction for this specific outbound-only use case.

### 2.3 Secure Withdrawal Queue Processing

Withdrawals must strictly be asynchronous to prevent race conditions, double-spending, and RPC timeouts.

1.  **Request Validation:**
    *   User requests a withdrawal.
    *   **Friction:** Cloudflare Turnstile token is validated to block headless bot-farms.
    *   **Anti-Cheat:** Backend verifies the user's recent score telemetry against statistical heuristics.
2.  **Ledger Deduction (Atomic):**
    *   Within a single database transaction, the user's in-game balance is deducted, and a `withdrawal_requests` row is created with status `PENDING`.
3.  **Queue Processing (BullMQ/Redis):**
    *   A dedicated Node.js worker picks up the `PENDING` job.
    *   The worker acquires a distributed lock (Redlock) on the `user_id` and `withdrawal_id` to guarantee it is only processed once.
4.  **Execution & Broadcasting:**
    *   Worker constructs the on-chain transfer.
    *   Worker securely requests the transaction signature from KMS/Vault.
    *   Worker broadcasts the signed transaction to the respective chain's RPC node.
5.  **Confirmation Polling:**
    *   The worker polls the RPC for transaction finality.
    *   **Success:** Updates the database row to `COMPLETED` and logs the `tx_hash`.
    *   **Failure/Revert:** If the transaction fails on-chain (e.g., RPC error, out of gas), the database row is marked `FAILED`, the user's in-game balance is refunded, and a high-priority alert is sent to the engineering team.
6.  **Monitoring:** Automated alerting (PagerDuty/Slack) triggers if any Hot Wallet balance (tokens or gas) drops below the 24-hour safety threshold.