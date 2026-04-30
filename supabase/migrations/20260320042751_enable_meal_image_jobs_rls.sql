alter table public.meal_image_jobs enable row level security;

create policy "meal_image_jobs_select_own"
  on public.meal_image_jobs
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "meal_image_jobs_insert_own"
  on public.meal_image_jobs
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "meal_image_jobs_update_own"
  on public.meal_image_jobs
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);;
