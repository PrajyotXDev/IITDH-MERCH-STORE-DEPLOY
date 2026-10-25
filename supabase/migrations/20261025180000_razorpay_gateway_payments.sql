-- Razorpay gateway payments. Additive/relaxing only; every other guard from the previous migration stays.
-- ROLLBACK: drop the new constraint/indexes/columns; restore orders_paid_requires_verification (manual_bank_verified only)
-- and the previous trigger body from 20261025120000_*.sql.
alter table public.orders
  add column if not exists razorpay_order_id text,
  add column if not exists razorpay_payment_id text;

create unique index if not exists orders_razorpay_order_unique_idx on public.orders (razorpay_order_id) where razorpay_order_id is not null;
create unique index if not exists orders_razorpay_payment_unique_idx on public.orders (razorpay_payment_id) where razorpay_payment_id is not null;

alter table public.orders drop constraint if exists orders_paid_requires_verification;
alter table public.orders add constraint orders_paid_requires_verification check (
  payment_status <> 'PAID'
  or (verified_at is not null and verified_by is not null and (
        verification_source = 'manual_bank_verified'
        or (verification_source = 'razorpay_verified' and payment_method = 'RAZORPAY'
            and razorpay_order_id is not null and razorpay_payment_id is not null))));

alter table public.orders add constraint orders_payment_method_check check (payment_method in ('UPI','RAZORPAY'));
alter table public.orders add constraint orders_razorpay_has_order_id check (payment_method <> 'RAZORPAY' or razorpay_order_id is not null);

create or replace function public.orders_guard_transitions() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if old.payment_status = 'PAID' and new.payment_status <> 'PAID' then
      raise exception 'PAID orders cannot change payment status';
    end if;
    if new.payment_status = 'PAID' and old.payment_status <> 'PAID'
       and not (old.payment_status = 'PENDING_REVIEW'
                or (old.payment_status = 'AWAITING_PAYMENT' and new.verification_source = 'razorpay_verified')) then
      raise exception 'Order cannot become PAID from its current state';
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
