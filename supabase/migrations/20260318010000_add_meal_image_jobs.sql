create table if not exists public.meal_image_jobs (
  id uuid primary key default gen_random_uuid(),
  planned_meal_id uuid not null references public.planned_meals(id) on delete cascade,
  user_id uuid not null,
  dish_index integer not null,
  job_kind text not null default 'dish',
  subject_hash text not null,
  idempotency_key text not null,
  prompt text not null,
  model text not null,
  reference_image_urls jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  priority integer not null default 100,
  lease_token uuid null,
  leased_until timestamptz null,
  last_error text null,
  result_image_url text null,
  request_id uuid null,
  trigger_source text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meal_image_jobs_status_priority_created_idx
  on public.meal_image_jobs (status, priority desc, created_at asc);

create index if not exists meal_image_jobs_planned_meal_dish_idx
  on public.meal_image_jobs (planned_meal_id, dish_index);

create index if not exists meal_image_jobs_user_created_idx
  on public.meal_image_jobs (user_id, created_at desc);

create unique index if not exists meal_image_jobs_idempotency_pending_idx
  on public.meal_image_jobs (idempotency_key)
  where status in ('pending', 'processing');
