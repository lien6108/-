-- Add branch support for itinerary spots (D1-A, D1-B, ...)
ALTER TABLE itinerary_spots ADD COLUMN branch TEXT NOT NULL DEFAULT '';
