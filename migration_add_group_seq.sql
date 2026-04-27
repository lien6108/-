-- Migration: Add group_seq column to expenses table
-- This adds per-group sequential numbering for expenses

-- Step 1: Add the group_seq column
ALTER TABLE expenses ADD COLUMN group_seq INTEGER NOT NULL DEFAULT 0;

-- Step 2: Backfill group_seq for existing data
-- Assigns sequential numbers per group, ordered by created_at
UPDATE expenses SET group_seq = (
  SELECT COUNT(*) FROM expenses e2 
  WHERE e2.group_id = expenses.group_id 
  AND e2.id <= expenses.id
);
