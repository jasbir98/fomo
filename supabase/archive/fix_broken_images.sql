-- One-time fix: 3 of the Unsplash photo IDs in the original seed.sql have
-- since 404'd (the photos were removed/deprecated on Unsplash's side).
-- seed.sql has been corrected for fresh installs, but re-running it won't
-- update rows you already seeded (it uses ON CONFLICT DO NOTHING). Run this
-- once to patch the existing rows in place.

update places
set image_url = 'https://images.unsplash.com/photo-1592194996308-7b43878e84a6?auto=format&fit=crop&w=600&q=80'
where name = 'Hedgehog Cafe';

update places
set image_url = 'https://images.unsplash.com/photo-1554797589-7241bb691973?auto=format&fit=crop&w=600&q=80'
where name = 'Mega Don Quijote';

update social_posts
set avatar_url = 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=150&q=80'
where author_handle = '@japan_wanderer';
