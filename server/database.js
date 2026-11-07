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

module.exports = db;