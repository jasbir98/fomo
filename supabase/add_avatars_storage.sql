-- Profile screen avatar upload. Public bucket + permissive RLS, matching
-- this repo's v0 convention: device-scoped by app-side convention, not by
-- auth (see the anon_all policies in schema.sql and the hardening note in
-- README.md).

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars_anon_all" on storage.objects;
create policy "avatars_anon_all" on storage.objects for all
  to anon using (bucket_id = 'avatars') with check (bucket_id = 'avatars');
