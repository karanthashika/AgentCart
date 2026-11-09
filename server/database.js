const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'agentcart.db'));

db.exec(`
    CREATE TABLE IF NOT EXISTS spending_rules (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        monthly_limit REAL NOT NULL,
        transaction_limit REAL NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_name TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'PENDING',
        paypal_order_id TEXT UNIQUE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'PENDING',
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
`);

const approvalColumns = db.prepare(
    'PRAGMA table_info(purchase_approvals)'
).all();

if (!approvalColumns.some((column) => column.name === 'approval_token_hash')) {
    db.exec(`
        ALTER TABLE purchase_approvals
        ADD COLUMN approval_token_hash TEXT
    `);
}

module.exports = db;