-- 讓購買清單可依照旅遊天數顯示
ALTER TABLE shopping_items ADD COLUMN day INTEGER NOT NULL DEFAULT 1;