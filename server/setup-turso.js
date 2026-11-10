require('dotenv').config();

async function setupTurso() {
    const { connect } = await import('@tursodatabase/serverless');

    const db = connect({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN
    });

    await db.batch([
        `CREATE TABLE IF NOT EXISTS spending_rules (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            monthly_limit REAL NOT NULL,
            transaction_limit REAL NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_name TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'USD',
            status TEXT NOT NULL DEFAULT 'PENDING',
            paypal_order_id TEXT UNIQUE,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,

        `CREATE TABLE IF NOT EXISTS purchase_approvals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL,
            product_name TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'USD',
            status TEXT NOT NULL DEFAULT 'PENDING',
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            approval_token_hash TEXT
        )`
    ]);

    const tables = await db.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );

    console.log('AgentCart cloud tables created:');
    console.log(tables);
}

setupTurso().catch(error => {
    console.error('Turso setup failed:', error);
});