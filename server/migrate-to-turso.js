
require('dotenv').config();

const Database = require('better-sqlite3');
const path = require('path');

const localDb = new Database(
    path.join(__dirname, 'agentcart.db'),
    { readonly: true }
);

async function migrate() {
    try {
        const { connect } = await import('@tursodatabase/serverless');

        const cloudDb = connect({
            url: process.env.TURSO_DATABASE_URL,
            authToken: process.env.TURSO_AUTH_TOKEN
        });

        const tables = [
            'spending_rules',
            'transactions',
            'purchase_approvals'
        ];

        // Safety check: don't duplicate existing cloud data.
        for (const table of tables) {
            const result = await cloudDb.get(
                `SELECT COUNT(*) AS total FROM ${table}`
            );

            if (result.total !== 0) {
                throw new Error(
                    `Cloud table ${table} is not empty. Migration stopped.`
                );
            }
        }

        // Read all existing local records.
        const migrationStatements = [];

        for (const table of tables) {
            const rows = localDb.prepare(
                `SELECT * FROM ${table}`
            ).all();

            console.log(`Found ${rows.length} records in ${table}`);

            for (const row of rows) {
                const columns = Object.keys(row);

                const placeholders = columns
                    .map(() => '?')
                    .join(', ');

                const sql = `
                    INSERT INTO ${table}
                    (${columns.join(', ')})
                    VALUES (${placeholders})
                `;

                migrationStatements.push({
                    sql,
                    args: columns.map(column => row[column])
                });
            }
        }

        if (migrationStatements.length === 0) {
            console.log('No records to migrate.');
            return;
        }

        // Copy all records in one atomic transaction.
        await cloudDb.batch(migrationStatements, 'immediate');

        console.log('\nMigration completed successfully!');

        // Verify cloud record counts.
        console.log('\nCLOUD DATABASE VERIFICATION');

        for (const table of tables) {
            const result = await cloudDb.get(
                `SELECT COUNT(*) AS total FROM ${table}`
            );

            console.log(`${table}: ${result.total}`);
        }

    } finally {
        localDb.close();
    }
}

migrate().catch(error => {
    console.error('\nMigration failed:', error.message);
});
