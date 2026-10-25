-- Staff-verified payment workflow. Backwards-compatible: only ADDs columns/constraints/trigger.
-- ROLLBACK (manual, only if needed):
--   drop trigger if exists orders_guard_transitions on public.orders;
--   drop function if exists public.orders_guard_transitions();
--   alter table public.orders drop constraint if exists orders_paid_requires_verification, ... (names below);
--   (added columns can stay; they are nullable/defaulted)

alter table public.orders
  add column if not exists payment_submitted_at timestamptz,
  add column if not exists verified_by text,
  add column if not exists verified_at timestamptz,
  add column if not exists rejected_by text,
  add column if not exists rejected_at timestamptz,
  add column if not exists reject_reason text,
  add column if not exists ack_email_status text not null default 'NOT_SENT',
  add column if not exists ack_email_error text,
  add column if not exists sheet_sync_error text,
  add column if not exists collection_token_issued_at timestamptz;

-- A new row is awaiting payment evidence, never "pending review" by default.
alter table public.orders alter column payment_status set default 'AWAITING_PAYMENT';

-- DB-level guarantees (not just app logic).
alter table public.orders
  add constraint orders_paid_requires_verification check (
    payment_status <> 'PAID'
    or (verified_by is not null and verified_at is not null and verification_source = 'manual_bank_verified')),
  add constraint orders_pending_requires_evidence check (
    payment_status <> 'PENDING_REVIEW'
    or (upi_reference is not null and screenshot_path is not null and screenshot_sha256 is not null and payment_submitted_at is not null)),
  add constraint orders_collection_requires_paid check (
    (collection_status = 'NOT_READY' and collection_token_hash is null)
    or (collection_status in ('READY','COLLECTED') and payment_status = 'PAID' and collection_token_hash is not null)),
  add constraint orders_collected_has_audit check (
    collection_status <> 'COLLECTED' or (collected_at is not null and collected_by is not null)),
  add constraint orders_no_plaintext_collection_token check (collection_token is null);

create or replace function public.orders_guard_transitions() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if old.payment_status = 'PAID' and new.payment_status <> 'PAID' then
      raise exception 'PAID orders cannot change payment status';
    end if;
    if new.payment_status = 'PAID' and old.payment_status <> 'PAID' and old.payment_status <> 'PENDING_REVIEW' then
      raise exception 'Only PENDING_REVIEW orders can become PAID';
    end if;
    if old.collection_status = 'COLLECTED' and (new.collection_status <> 'COLLECTED'
        or new.collected_at is distinct from old.collected_at
        or new.collected_by is distinct from old.collected_by) then
      raise exception 'COLLECTED orders are immutable';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

revoke all on function public.orders_guard_transitions() from public, anon, authenticated;

drop trigger if exists orders_guard_transitions on public.orders;
create trigger orders_guard_transitions before update on public.orders
  for each row execute function public.orders_guard_transitions();

-- orders_active_payable_amount_unique would collide for concurrent flat-price (₹1) orders.
-- It is kept in place; the server never sets payable_amount_paise, so it never triggers.
