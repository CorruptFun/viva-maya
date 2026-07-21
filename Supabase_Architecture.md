# Supabase Architecture & Game Security Protocol: Viva Ton Web3

This document outlines the core Supabase SQL schemas and the secure client-server handshake protocol for Viva Ton Web3. The primary objective is to build a trustless architecture where the backend deterministically validates all game outcomes to prevent botting, API spoofing, and score manipulation.

---

## 1. Supabase SQL Schema Definitions

The database design relies on Supabase's built-in PostgreSQL capabilities, utilizing Row Level Security (RLS) and foreign key constraints to maintain data integrity.

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================
-- 1. USERS
-- Maps to Supabase's auth.users
-- ==========================================
CREATE TABLE public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username VARCHAR(50) UNIQUE NOT NULL,
    total_score BIGINT DEFAULT 0,
    is_banned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: Users can only read their own data, server handles updates.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON public.users FOR SELECT USING (auth.uid() = id);

-- ==========================================
-- 2. WALLETS
-- Stores user Web3 wallet addresses
-- ==========================================
CREATE TABLE public.wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    wallet_address VARCHAR(130) UNIQUE NOT NULL,
    network VARCHAR(20) DEFAULT 'ethereum', -- e.g., polygon, ethereum, solana
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, network)
);

ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own wallets" ON public.wallets FOR ALL USING (auth.uid() = user_id);

-- ==========================================
-- 3. AD_CALLBACKS
-- Secure tracking of ad views for revenue allocation
-- ==========================================
CREATE TABLE public.ad_callbacks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id),
    ad_network_tx_id VARCHAR(255) UNIQUE NOT NULL,
    provider VARCHAR(50) NOT NULL, -- e.g., 'applovin', 'admob'
    reward_amount DECIMAL(18,8) NOT NULL,
    signature VARCHAR(255), -- Cryptographic signature from the ad provider
    status VARCHAR(20) DEFAULT 'pending', -- pending, verified, rejected
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ad_callbacks ENABLE ROW LEVEL SECURITY;
-- No public RLS policies; only Server/Edge Functions can write to this via service_role key.

-- ==========================================
-- 4. GAME_SESSIONS (Crucial for Security)
-- Tracks active games for deterministic validation
-- ==========================================
CREATE TABLE public.game_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id),
    seed VARCHAR(64) NOT NULL, -- Server-generated RNG seed
    status VARCHAR(20) DEFAULT 'active', -- active, completed, invalidated
    claimed_score INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    client_ip INET
);

ALTER TABLE public.game_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own sessions" ON public.game_sessions FOR SELECT USING (auth.uid() = user_id);

-- ==========================================
-- 5. LEDGER
-- Immutable transaction log for crypto/in-game currency
-- ==========================================
CREATE TABLE public.ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id),
    amount DECIMAL(18,8) NOT NULL,
    transaction_type VARCHAR(50) NOT NULL, -- 'game_reward', 'ad_reward', 'withdrawal'
    reference_id UUID, -- Links to game_sessions.id or ad_callbacks.id
    balance_after DECIMAL(18,8) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own ledger" ON public.ledger FOR SELECT USING (auth.uid() = user_id);
-- No public INSERT/UPDATE; only Edge Functions process ledger entries.
```

---

## 2. Highly Secure Client-Server Handshake Protocol

Because clients (web/mobile apps) run on user devices, they **cannot be trusted**. A simple `POST /score {points: 5000}` will immediately be exploited by bots to drain ad revenue or crypto pools. 

To prevent this, we use a **Deterministic Gameplay Validation (DGV)** approach. Both the Client and the Server share the exact same Pseudo-Random Number Generator (PRNG) logic (e.g., Mulberry32 or XorShift) and the same Match-3 board evaluation logic.

### 2.1. Protocol Flow

#### Phase 1: Game Initialization (Handshake)
1. **Client Request:** The user hits "Play". Client sends `POST /game/start` (authenticated with Supabase JWT).
2. **Server Action:** 
   - A Supabase Edge Function creates a new `game_session` record.
   - It generates a cryptographically secure, unpredictable **`seed`**.
   - It records the `session_id` and `seed` in the database with status `active`.
3. **Server Response:** Returns `{ session_id: "uuid", seed: "xyz123..." }`.

#### Phase 2: Gameplay (Deterministic Execution)
1. **Board Generation:** The Client initializes its match-3 board using the server-provided `seed`. Because PRNG is deterministic, the starting board is mathematically guaranteed to be identical to what the server *would* generate.
2. **Move Logging:** As the user plays, the client does **not** calculate points to send to the server. Instead, it records a **Move Log**.
   - Example Move: `{ turn: 1, action: "swap", pos1: [2,3], pos2: [2,4], timestamp: 1690000123 }`
3. **RNG Progression:** Every new block that falls into the board is generated by advancing the seeded PRNG.

#### Phase 3: Game Completion & Validation
1. **Client Submission:** When the game ends (e.g., out of moves, timer ends), the client sends a payload to `POST /game/submit`:
   ```json
   {
     "session_id": "uuid",
     "move_log": [
       {"t": 1, "p1": [2,3], "p2": [2,4]},
       {"t": 2, "p1": [5,1], "p2": [5,2]}
     ],
     "claimed_score": 1500,
     "client_hash": "SHA256(seed + move_log + client_secret)" 
   }
   ```
2. **Server-Side Simulation (The Heart of the Security):**
   - The Supabase Edge Function retrieves the `seed` for the given `session_id`.
   - It checks that the session is still `active` (prevents replay attacks).
   - **Simulation Engine:** The Edge Function spins up an instance of the Match-3 game logic in a headless state.
   - It applies the `seed` and feeds the `move_log` into the engine, one by one.
3. **Verification:**
   - The Server engine arrives at a final score.
   - *Is `Server_Score == claimed_score`?*
     - **YES:** The game is legitimate. Update `game_sessions` to `completed`. Mint rewards and write to the `ledger`.
     - **NO:** The client tampered with the memory, cheated, or spoofed a score. Flag the user, update session to `invalidated`, issue a ban warning, and grant 0 rewards.

### 2.2. Defense in Depth
* **Time Constraints:** The server verifies timestamps. If a game normally takes 3 minutes, but the server receives a 3-minute move log 5 seconds after the `game/start` handshake, it's a bot. Reject immediately.
* **Ad-Callback Verification:** Webhooks from ad providers (AppLovin, AdMob) are routed directly to Supabase Edge Functions. They check the `ad_network_tx_id` and the cryptographic signature provided by the ad network before writing to `ad_callbacks` and updating the user's ledger.
* **Obfuscation:** The PRNG logic and client-side move logging should be heavily obfuscated in the production build to make reverse-engineering the move schema annoying for script kiddies.
* **No Trust in Time:** Clients can manipulate device clocks. Use only server-side timestamps (`created_at`, `ended_at`) for duration validation.