-- sync_profile_identity.sql — copy the sign-in provider's name into profiles.
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Why: handle_new_user() only inserted user_id, so profiles.display_name was
-- null for everyone, even Google users whose name Google already gave us
-- (auth.users.raw_user_meta_data ->> 'full_name' / 'name').
--
-- Photos are deliberately NOT copied: the app reads the Google photo straight
-- from user_metadata (lib/auth/identity.ts avatarUrlOf), so it stays current
-- when someone changes their Google picture, and profiles.avatar_url keeps
-- meaning "a photo this user uploaded" (Profile's Remove only applies to that).

-- 1. New sign-ups: take the provider's name when there is one.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    nullif(left(trim(coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    )), 50), '')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- 2. Existing users: fill only names that are still empty. Never overwrites
--    a name someone set themselves.
update public.profiles p
set display_name = nullif(left(trim(coalesce(
      u.raw_user_meta_data ->> 'full_name',
      u.raw_user_meta_data ->> 'name'
    )), 50), '')
from auth.users u
where u.id = p.user_id
  and (p.display_name is null or trim(p.display_name) = '')
  and coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name') is not null;

-- 3. Check (the editor shows this last result): who has a name now.
select
  count(*)                                            as profiles,
  count(*) filter (where display_name is not null)    as with_name
from public.profiles;
