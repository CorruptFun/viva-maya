# Implementation Roadmap: Viva Maya Web3

This document breaks the architecture down into actionable Epics and Tasks for the development team. 

## Technical Blind Spots Addressed
1. **DGV Seed Tampering:** If a client can predict the seed, they can pre-calculate the perfect move log. **Fix:** The server must use a Cryptographically Secure Pseudo-Random Number Generator (CSPRNG) to generate the initial seed, not `Math.random()`.
2. **KMS Rate Limiting:** Cloud KMS providers rate-limit signing requests. **Fix:** The BullMQ queue must have a concurrency limit and exponential backoff for KMS signing to prevent backend crashes during a mass-cashout event.
3. **App Store Review Mode:** Apple will reject the app if they see crypto wallets. **Fix:** The "Gift Shop" and wallet linking UI must be governed by a remote feature flag (e.g., Supabase Edge Config). It remains completely hidden until *after* the app is approved by reviewers.

---

## Epic 1: The Core Relay (Backend Foundation)
*   **Task 1.1:** Initialize the Supabase project and apply the SQL schemas from `Supabase_Architecture.md`.
*   **Task 1.2:** Set up Supabase Auth (Email/Password & Social OAuth).
*   **Task 1.3:** Build the `POST /game/start` Edge Function (generates session UUID + CSPRNG seed).
*   **Task 1.4:** Build the headless Match-3 Validator (Port the Phaser board logic to a pure Node.js/TypeScript module).
*   **Task 1.5:** Build the `POST /game/submit` Edge Function (executes the DGV handshake and updates the ledger).

## Epic 2: The Ad-Revenue Engine
*   **Task 2.1:** Select Ad Network (Recommendation: Unity Ads for Web/Mobile).
*   **Task 2.2:** Integrate the Ad SDK into the Phaser 3 client.
*   **Task 2.3:** Build the `POST /api/ad-webhook` Supabase Edge Function to receive S2S postbacks.
*   **Task 2.4:** Implement cryptographic signature verification on the webhook to reject spoofed requests.

## Epic 3: The Multi-Chain Treasury
*   **Task 3.1:** Deploy the `$VIVA` token contracts to Solana, Base, and Sui (Testnet).
*   **Task 3.2:** Set up HashiCorp Vault or AWS KMS and generate 3 Treasury Master Keys.
*   **Task 3.3:** Build the Redis/BullMQ worker infrastructure in Node.js.
*   **Task 3.4:** Write the `process-withdrawal` job logic:
    - Lock user row.
    - Fetch KMS signature.
    - Broadcast via respective RPC (Solana/Base/Sui).
    - Update ledger on success/failure.

## Epic 4: Client Integration & "Gift Shop"
*   **Task 4.1:** Strip `localStorage` state from Viva Maya and replace it with Supabase REST calls.
*   **Task 4.2:** Build the "Maya Tickets" UI overlay (replacing old score displays).
*   **Task 4.3:** Build the "Prize Tent" React/Phaser UI (Remote Feature Flagged).
*   **Task 4.4:** Integrate Cloudflare Turnstile CAPTCHA on the withdrawal button.