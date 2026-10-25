-- Durable orders and private payment proofs for IITDH merch.
-- Student-submitted UTR/screenshot must never mark an order PAID.
create extension if not exists pgcrypto;

alter table public.orders
  add column if not exists screenshot_path text,
  add column if not exists screenshot_sha256 text,
  add column if not exists vendor_exported_at timestamptz,
  add column if not exists vendor_export_batch text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists orders_status_created_idx on public.orders (payment_status, created_at desc);
create unique index if not exists orders_upi_reference_unique_idx
  on public.orders (lower(upi_reference)) where upi_reference is not null and length(trim(upi_reference)) > 0;
create unique index if not exists orders_screenshot_sha_unique_idx
  on public.orders (screenshot_sha256) where screenshot_sha256 is not null;
create index if not exists orders_vendor_export_idx
  on public.orders (vendor_exported_at, created_at desc);

alter table public.orders enable row level security;
alter table public.unmatched_payments enable row level security;

-- No direct browser access to customer/order tables. Server-side service credentials only.
revoke all on table public.orders from anon, authenticated;
revoke all on table public.unmatched_payments from anon, authenticated;
grant all on table public.orders to service_role;
grant all on table public.unmatched_payments to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=false, file_size_limit=3145728, allowed_mime_types=array['image/jpeg','image/png','image/webp'];

-- Private bucket: no anon/authenticated object access policies. Server uses service_role.
drop policy if exists "payment proofs public read" on storage.objects;
drop policy if exists "payment proofs public upload" on storage.objects;
