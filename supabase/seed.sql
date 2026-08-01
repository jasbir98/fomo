-- Roameo v0 Seed Data
-- Seed is re-runnable via ON CONFLICT DO NOTHING
-- Shared read-only data: places and social_posts

-- Clear existing data (optional; comment out if you prefer upsert behavior)
-- delete from social_posts;
-- delete from places;

-- ============================================================================
-- PLACES SEED DATA
-- ============================================================================
insert into places (name, category, rating, image_url, distance_label, tips, reviews, hours, station, badges)
values
  (
    'Senso-ji Temple',
    'Historical Site',
    4.8,
    'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=600&q=80',
    '0.2 km',
    '["Photography tip: Best time to visit for photos is 5:30 PM when the lanterns illuminate as the sun sets.", "Local snack: Try the melonpan at the stall near the Kaminarimon gate; it''s famously crispy and warm."]'::jsonb,
    '[{"author": "Sarah Mitchell", "rating": 5, "text": "Absolutely breathtaking! The atmosphere is electric but spiritual at the same time. Must see in Tokyo."}, {"author": "Kenji Sato", "rating": 4, "text": "Crowded but managed well. The architecture is stunning and the surrounding shops are delightful."}, {"author": "Alex Chen", "rating": 5, "text": "The ritual with the incense smoke is a unique experience. Definitely arrive early to beat the main crowd."}]'::jsonb,
    '6:00 AM - 5:00 PM',
    'Asakusa Station',
    '{"Quiet now"}'
  ),
  (
    'Shibuya Sky',
    'Observation Deck',
    4.9,
    'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=600&q=80',
    '0.3 km',
    '["The sunset glare is perfect right now. Avoid the rush hour crowds later.", "Best views are from the east side of the observation deck around golden hour."]'::jsonb,
    '[{"author": "Emma Wilson", "rating": 5, "text": "Stunning 360-degree views of Tokyo. The sunset was unforgettable and worth every yen."}, {"author": "Taro Yamamoto", "rating": 5, "text": "A must-visit when in Shibuya. The night lights are absolutely magical."}]'::jsonb,
    '10:00 AM - 10:00 PM',
    'Shibuya Station',
    '{"Trending"}'
  ),
  (
    'Tsutaya Books',
    'Bookstore & Cafe',
    4.7,
    'https://images.unsplash.com/photo-1524413840807-0c3cb6fa808d?auto=format&fit=crop&w=600&q=80',
    '0.5 km',
    '["Great spot to chill while waiting for your dinner reservation.", "Browse rare design books and photography collections on the top floor."]'::jsonb,
    '[{"author": "Lisa Chen", "rating": 5, "text": "A bibliophile''s paradise. The design and architecture of the store is as impressive as the book selection."}, {"author": "Jun Nakamura", "rating": 4, "text": "Perfect place to spend an afternoon. The cafe is cozy and the staff are helpful."}]'::jsonb,
    '7:00 AM - 2:00 AM',
    'Roppongi Station',
    '{"Late hours"}'
  ),
  (
    'The Roasters Guild',
    'Coffee Shop',
    4.8,
    'https://images.unsplash.com/photo-1493857671505-72967e2e2760?auto=format&fit=crop&w=600&q=80',
    '0.1 km',
    '["Fits perfectly before your 3:00 PM train departing from Central Station.", "Their single-origin espresso is roasted in-house; ask the barista for a recommendation."]'::jsonb,
    '[{"author": "David Park", "rating": 5, "text": "Best pour-over coffee in the city. The baristas really know their craft."}, {"author": "Yuki Sato", "rating": 5, "text": "Excellent coffee and pastries. A local favorite that deserves more recognition."}]'::jsonb,
    '8:00 AM - 6:00 PM',
    'Chiyoda Station',
    '{"Quiet now"}'
  ),
  (
    'Osteria Modern',
    'Italian Fusion',
    4.9,
    'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=600&q=80',
    '0.4 km',
    '["Usually quiet around this time. 5 min walk from here.", "Try the handmade pasta special; it changes daily and is always exceptional."]'::jsonb,
    '[{"author": "Marco Rossi", "rating": 5, "text": "Authentic Italian cuisine with a modern twist. The chef really understands flavor balance."}, {"author": "Akiko Tanaka", "rating": 5, "text": "Romantic ambiance and impeccable service. A culinary masterpiece."}]'::jsonb,
    '11:30 AM - 11:00 PM',
    'Roppongi Station',
    '{"Trending"}'
  ),
  (
    'Omoide Yokocho',
    'Historic Alleyway',
    4.6,
    'https://images.unsplash.com/photo-1493857671505-72967e2e2760?auto=format&fit=crop&w=600&q=80',
    '0.3 km',
    '["Historic alleyway packed with tiny yakitori stalls. A quick, atmospheric dive into retro Tokyo.", "Visit at night for the full neon-lit alley experience with locals and travelers mingling."]'::jsonb,
    '[{"author": "Hiroshi Nakamura", "rating": 5, "text": "A hidden gem that feels frozen in time. The yakitori is cheap and delicious."}, {"author": "Sophie Miller", "rating": 4, "text": "Authentic Tokyo experience. A bit crowded but charming and memorable."}]'::jsonb,
    '11:00 AM - 11:00 PM',
    'Shinjuku Station',
    '{"Hidden gem"}'
  ),
  (
    'Hedgehog Cafe',
    'Animal Cafe',
    4.7,
    'https://images.unsplash.com/photo-1592194996308-7b43878e84a6?auto=format&fit=crop&w=600&q=80',
    '0.1 km',
    '["A unique cafe experience where you can interact with hedgehogs while grabbing a quick coffee.", "Bring hand sanitizer and be gentle with the animals; they''re shy but adorable."]'::jsonb,
    '[{"author": "Katie Johnson", "rating": 5, "text": "Cutest hedgehogs ever! The cafe is clean, the staff are caring, and the coffee is good."}, {"author": "Riku Yamada", "rating": 5, "text": "A stress-relief haven. Perfect for animal lovers and Instagram-worthy moments."}]'::jsonb,
    '12:00 PM - 8:00 PM',
    'Harajuku Station',
    '{"Pet-friendly"}'
  ),
  (
    'Mega Don Quijote',
    'Discount Store',
    4.5,
    'https://images.unsplash.com/photo-1554797589-7241bb691973?auto=format&fit=crop&w=600&q=80',
    '0.8 km',
    '["Grab some late-night snacks or quirky souvenirs.", "Navigate carefully; it''s massive and easy to get lost, but that''s part of the adventure."]'::jsonb,
    '[{"author": "Michael Chen", "rating": 4, "text": "Iconic Tokyo experience. Chaotic but fun. Great for last-minute souvenirs."}, {"author": "Naomi Sato", "rating": 4, "text": "24-hour convenience is great. Prices are reasonable for Tokyo."}]'::jsonb,
    '24 Hours',
    'Shinjuku Station',
    '{"24/7", "Budget-friendly"}'
  )
on conflict do nothing;

-- ============================================================================
-- SOCIAL POSTS SEED DATA
-- ============================================================================
insert into social_posts (author_handle, avatar_url, image_url, caption, likes, location)
values
  (
    '@tokyo_vibes',
    'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=150&q=80',
    'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=400&q=80',
    'Found this hidden alleyway in Shinjuku! The neon lights are incredible at night. #TokyoNightlife',
    1284,
    'Shinjuku, Tokyo'
  ),
  (
    '@sakura_adventures',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=150&q=80',
    'https://images.unsplash.com/photo-1524413840807-0c3cb6fa808d?auto=format&fit=crop&w=400&q=80',
    'The best matcha latte I''ve ever had. This cafe in Harajuku is a must-visit! 🍵 #TokyoEats',
    2156,
    'Harajuku, Tokyo'
  ),
  (
    '@japan_wanderer',
    'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=150&q=80',
    'https://images.unsplash.com/photo-1493857671505-72967e2e2760?auto=format&fit=crop&w=400&q=80',
    'Early morning at Senso-ji Temple. So peaceful before the crowds arrive. 🙏 #Asakusa',
    3421,
    'Asakusa, Tokyo'
  )
on conflict do nothing;
