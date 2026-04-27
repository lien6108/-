DROP TABLE IF EXISTS expense_splits;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS trips;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS exchange_rates;
DROP TABLE IF EXISTS system_settings;

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  session_open INTEGER DEFAULT 0,
  current_trip_id INTEGER
);

CREATE TABLE trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  trip_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,
  FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT DEFAULT 'Unknown',
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_participating INTEGER DEFAULT 0,
  FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  trip_id INTEGER,
  group_seq INTEGER NOT NULL DEFAULT 1,
  payer_user_id TEXT NOT NULL,
  payer_name TEXT DEFAULT 'Unknown',
  description TEXT DEFAULT '',
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'TWD',
  original_amount REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_settled INTEGER DEFAULT 0,
  FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE SET NULL
);

CREATE TABLE expense_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id INTEGER NOT NULL,
  debtor_user_id TEXT NOT NULL,
  debtor_name TEXT DEFAULT 'Unknown',
  share_amount REAL NOT NULL,
  is_paid INTEGER DEFAULT 0,
  FOREIGN KEY(expense_id) REFERENCES expenses(id) ON DELETE CASCADE
);

CREATE TABLE exchange_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  currency_code TEXT UNIQUE NOT NULL,
  rate REAL NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  user_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  step TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO system_settings (key, value) VALUES ('maintenance_mode', '0');
