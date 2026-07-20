-- ============================================================================
-- 0001_saves.sql
-- Minimal per-user cloud-save slice of Supabase_Architecture.md
--
-- This is the FIRST and smallest piece of the architecture described in
-- Supabase_Architecture.md. It implements ONLY a single-row-per-user cloud
-- save (the entire game SaveData blob stored as JSON). The wallets, ledger,
-- game_sessions and deterministic anti-cheat pieces from that document are
-- intentionally NOT included in this migration yet.
--
-- Security model: Row Level Security (RLS) restricts every row to its owner
-- (auth.uid() = user_id). The Supabase anon / public key is safe to ship in
-- the client precisely because these policies gate all access -- the key only
-- ever grants what RLS allows for the currently signed-in user.
--
-- This migration is written to be idempotent-friendly (safe to re-run): it
-- uses CREATE TABLE IF NOT EXISTS and DROP ... IF EXISTS before each CREATE.
-- ============================================================================

-- ==========================================
-- TABLE: public.saves
-- One row per user; holds the whole game SaveData blob as jsonb.
-- ==========================================
create table if not exists public.saves (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    data       jsonb not null,
    updated_at timestamptz not null default now()
);

-- Deny-by-default: with RLS enabled and no permissive policy matched, access
-- is refused. The policies below re-grant access to each row's owner only.
alter table public.saves enable row level security;

-- ==========================================
-- RLS POLICIES
-- A signed-in user may read/write ONLY their own row (auth.uid() = user_id).
-- No policy grants access to other users' rows, and the anon role matches
-- none of these (auth.uid() is null when unauthenticated), so cross-user and
-- anonymous access are denied.
-- ==========================================

drop policy if exists "Users can view own save" on public.saves;
create policy "Users can view own save"
    on public.saves
    for select
    using (auth.uid() = user_id);

drop policy if exists "Users can insert own save" on public.saves;
create policy "Users can insert own save"
    on public.saves
    for insert
    with check (auth.uid() = user_id);

drop policy if exists "Users can update own save" on public.saves;
create policy "Users can update own save"
    on public.saves
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

drop policy if exists "Users can delete own save" on public.saves;
create policy "Users can delete own save"
    on public.saves
    for delete
    using (auth.uid() = user_id);

-- ==========================================
-- TRIGGER: keep updated_at fresh on every UPDATE.
-- The column DEFAULT already stamps now() on INSERT; this ensures the value
-- also advances whenever an existing save row is overwritten, regardless of
-- what the client sends. search_path is pinned to '' as a hardening measure
-- (now() lives in pg_catalog, which is always resolvable).
-- ==========================================
create or replace function public.set_saves_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_saves_updated_at on public.saves;
create trigger trg_saves_updated_at
    before update on public.saves
    for each row
    execute function public.set_saves_updated_at();
