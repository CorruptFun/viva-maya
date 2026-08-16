# Paid entry & referral cash

How the $3.99 buy-in and the cash referral commissions actually work, and how to
run them. This is the **mechanism and the runbook**. Pricing strategy, margin
modelling and the risk register live in the private vault, not here — see the
note at the bottom of `CLAUDE.md` about what this repo's visibility makes
expensive.

## The shape of it

A new account pays **$3.99 once**, before its first board. One cash commission
is written per paid arrival, to that player's **direct referrer**, at a rate set
by *that referrer's* own position in the invite chain:

| Referrer's depth | Who they are | Cash per paid referral |
|---|---|---|
| 0 | arrived organically | **$1.69** |
| 1 | joined through a depth-0 link | **$0.69** |
| 2+ | joined through a depth-1 link or deeper | **nothing** — chips and hearts only |

Depth is derived from the existing `referrals` chain (`public.referral_depth`),
never stored on the user — the chain is already immutable, so a depth column
would be a second copy of a fact that cannot change. The rate that was *actually
paid* is frozen onto the ledger row (`referral_earnings.tier`), because a chain
edited later must not restate a settled commission.

**The in-game rewards are unchanged and still universal.** Every referrer at
every depth still earns `REFERRER_CHIPS` + a lives refill per qualified friend
(`core/referrals.ts`). Cash is added on top for the first two rungs; it does not
replace anything.

### One entry fee pays at most one person

This is the property that keeps the program safe at any size, and it is one
careless constant away from being false. `$1.69` plus Stripe's `$0.42` on a
`$3.99` charge leaves the house solvent on **every individual transaction**, not
on average — so no mix of referral depths and no growth rate can put it
underwater. A second payout rung stacked on the same fee would break that.

`referralcash.test.ts` is an **economy guard** in the family of
`slots.rate` / `plinko.rate` / `endless.pace`: it asserts solvency per depth
against the real constants. If you retune a rate, the recorded margins in it are
what you **re-derive** — never what you edit to make green.

## Money is not self-reported

Everything else this game writes follows the trust model in migrations
0002/0006/0007/0012: the client claims, RLS confines, a trigger keeps it
monotonic. That is right for a leaderboard, where the worst case is a fake
score. It is wrong here, where the worst case is a client minting its own
entitlement.

So `entitlements`, `referral_earnings`, `payout_accounts` and `payouts` have
**SELECT policies for their owner and no INSERT/UPDATE/DELETE policy for any
role**. Under RLS that is a denial. The only writer is `service_role`, held
exclusively by the Edge Functions. *If you find yourself adding a write policy
to one of these tables to make a client feature work, the feature is wrong.*

The client-side paywall is a **funnel, not a lock** — the game is a static
bundle the player's browser runs, so anyone willing to edit localStorage can
walk past it, exactly as anyone willing to edit a POST body can fake a score.
What is not bypassable is the money: a forged client can grant itself a free
game and can never grant itself a cent.

## The switch

`PAYWALL_ACTIVE_FROM` (`core/entitlement.ts`) and `public.paywall_active_from()`
(migration 0025) are **the same switch on two sides of the wire — change one,
change both**, exactly like `SALT_ACTIVE_FROM` / `v_salt_from`.

The server half decides who is **grandfathered** (an account created before the
instant never pays, checked against `auth.users.created_at`, which a client
cannot forge). The client half decides who is **shown** the paywall.

Rolling back is moving the date forward. Nobody who has already paid is affected
— their entitlement row outranks the date.

### Grandfathering, and its soft edge

Sign-in is optional in this game, so a large share of existing players have no
account for the server to recognise them by. The client therefore *also* honours
a local save whose `firstPlayDate` predates the switch day. **That check is
forgeable.** It is a deliberate trade: the alternative is billing loyal players
for a game they already own, and the forgery buys only a free game, never a cash
commission. The paywall's signed-out state pushes those players toward sign-in,
which converts them to the durable server-side path.

A **server verdict for the current account beats the local clause, in both
directions.** That ordering is load-bearing: a refunded account's save is by then
genuinely old enough to look grandfathered, and the forgeable clause must not
overrule a refusal. `entitlement.test.ts` pins it.

## The gate is read once, at boot

`BootScene` reads `mayPlay()` — synchronous, cache-only, no network — before any
other routing decision. `refreshAccess()` runs fire-and-forget from `main.ts`
*after* the game has started and writes only the cache, so **a revocation lands
on the next launch**.

This is on purpose. Ejecting a player from a level they are winning because a
background call came back unfavourably is a far worse bug than a few extra
minutes of free play — and from inside the client, the honest cases (a slow
webhook, a token refresh, a flaky network) look exactly like the dishonest ones.

## Fulfilment is not synchronous with the redirect

Stripe returns the player to `?paid=1` the instant the card clears, but the
entitlement is written by the **webhook**, a separate request Stripe makes to us.
`PaywallScene`'s `confirming` state covers that window by polling
`awaitEntitlement()`. Rendering the price there would be showing a bill to
somebody who has just paid it.

If the wait runs out, the `failed` state must **never say the payment failed** —
it didn't; the card has been charged. It says the receipt is slow and offers to
look again. Telling a charged player their payment failed sends them to their
bank, and the bank's answer to that is a chargeback.

## The chargeback hole

Cash out of a card charge is reversible in one direction only. The attack: buy
with a stolen card, refer a second account you control, withdraw, dispute.

Three things close it, all server-side:

1. **A 30-day hold.** Commissions land `pending` with
   `available_at = now() + HOLD_DAYS`. Only the payout function's own query
   promotes them; nothing a client can call moves that date.
2. **Reversal.** `charge.refunded` / `charge.dispute.created` flips the
   commission to `reversed` and the entitlement to `refunded`. A commission
   already paid out is *still* flipped — the cash is gone, so what the row
   records is a **debt**. `reversed_at` on a row with a `payout_id` is exactly
   the query that finds referrers paid for charges that later failed, which is
   how a farming ring shows itself.
3. **One commission per referred account, ever** — `referral_earnings
   .referee_user_id` is UNIQUE. A database constraint, not application logic:
   a replayed webhook physically cannot pay twice.

Self-referral farming is *structurally* unprofitable (each fake account costs
$3.99 to earn $1.69) and the card fingerprint recorded on `entitlements` makes
one instrument funding several accounts visible.

## Payout ordering

Money leaving is the one action that cannot be undone by a retry, so
`functions/payout` **claims the ledger before the transfer and settles after**:

1. **claim** — stamp `payout_id` on every eligible row `WHERE payout_id IS NULL`.
   Atomic: a concurrent second invocation matches zero rows, so a double-tapped
   CASH OUT cannot double-pay.
2. **transfer** — Stripe, with the payout id as the idempotency key. A retry
   returns the *original* transfer instead of creating a second one.
3. **settle** — mark the claimed rows `paid`.
   On failure, **release** (`payout_id = null`) so the balance is withdrawable
   again rather than stranded.

A crash between 1 and 3 leaves rows claimed by a `pending` payout. That is
recoverable by hand and visible (`select * from payouts where status='pending'`)
— the right trade, since the other ordering loses money instead of stranding it.

## Deploying it

```sh
# 1. schema
supabase db push --dry-run --include-all   # always look first
supabase db push --include-all
./scripts/verify-rls.sh

# 2. secrets
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.

# 3. functions
supabase functions deploy create-checkout
supabase functions deploy connect-onboard
supabase functions deploy payout
supabase functions deploy stripe-webhook --no-verify-jwt   # ⚠️ see below
```

**`stripe-webhook` MUST be deployed with `--no-verify-jwt`.** Stripe cannot send
a Supabase JWT; the *signature header* is what authenticates that endpoint, and
it is verified before the body is parsed. Every other function keeps JWT
verification on.

Point the Stripe webhook at
`https://<project>.functions.supabase.co/stripe-webhook` and subscribe:
`checkout.session.completed`, `charge.refunded`, `charge.dispute.created`,
`account.updated`, `transfer.reversed`.

On the Stripe side you also need **Connect (Express) enabled** — that is what
collects referrers' identity and bank details, and what files 1099s at the US
$600/yr threshold if you turn tax reporting on. **We never see any of it**: the
flow is Stripe-hosted end to end and all this project stores is an account id
and Stripe's own boolean verdict on whether that account may receive money.

### Return-URL allowlist

`ALLOWED_RETURN_PREFIXES` in `functions/_shared/deps.ts` is a **security
control, not configuration**. `success_url` and Connect's `return_url` arrive in
a request body; an unchecked one turns these functions into an open redirect a
phishing page can drive. A new origin must be added there or players are silently
sent to the canonical address instead.

## Cached clients

The PWA is `registerType: 'prompt'` and players run cached bundles for days
(13 distinct builds were live at once on 2026-08-07). Migration 0025 is purely
additive and no existing client reads any of it, so applying it changes nothing
for anyone.

A stale client that predates the paywall simply lets its player play free. That
is the deliberate failure direction: a locked-out paying customer is a refund and
a support ticket; a free play is a rounding error.

## Measuring it

```
paywall_shown → signin_completed → checkout_started → entry_paid
cashout_shown → cashout_requested
```

`signin_completed` is **reused** rather than given a paywall-specific twin, and
new information rides on props rather than new event names — the dashboard's SQL
hardcodes the names it charts (`name in (...)` across migrations
0014/0015/0021/0022), so a *new* event is invisible until a new migration ships
and fails silently, whereas a new prop is queryable the moment it lands.

`paywall_shown`'s `{state}` prop matters: without it, "the paywall converts at
4%" pools people who were asked to pay with people who had already paid and were
waiting on a receipt.

`cashout_requested`'s `onboarding` outcome is the one to watch — a full identity
and bank verification standing between a referrer and money they have already
earned is the most likely place for the cash program to quietly fail to pay
anybody at all.

## Files

| path | role |
|---|---|
| `src/core/entitlement.ts` | the gate — the switch, the cache, grandfathering, checkout |
| `src/core/referralcash.ts` | the cash tier model + the read/payout surface |
| `src/scenes/PaywallScene.ts` | the door — four states, one plate |
| `src/view/cashout.ts` | YOUR EARNINGS panel (opened from the Store's balance row) |
| `supabase/migrations/0025_paid_entry_and_referral_cash.sql` | the four tables, their RLS, the depth + rate functions |
| `supabase/functions/create-checkout` | opens Checkout — sets the price, resolves the referrer |
| `supabase/functions/stripe-webhook` | the only writer of entitlements and commissions |
| `supabase/functions/connect-onboard` | Stripe Connect onboarding link |
| `supabase/functions/payout` | claim → transfer → settle |
