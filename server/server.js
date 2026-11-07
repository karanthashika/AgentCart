
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Save spending rules
app.post('/api/rules', (req, res) => {
    const { monthlyLimit, transactionLimit } = req.body;

    if (
        typeof monthlyLimit !== 'number' ||
        typeof transactionLimit !== 'number' ||
        !Number.isFinite(monthlyLimit) ||
        !Number.isFinite(transactionLimit) ||
        monthlyLimit <= 0 ||
        transactionLimit <= 0 ||
        transactionLimit > monthlyLimit
    ) {
        return res.status(400).json({
            success: false,
            message: 'Please provide valid spending limits.'
        });
    }

    const saveRules = db.prepare(`
        INSERT INTO spending_rules (id, monthly_limit, transaction_limit)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            monthly_limit = excluded.monthly_limit,
            transaction_limit = excluded.transaction_limit,
            updated_at = CURRENT_TIMESTAMP
    `);

    saveRules.run(monthlyLimit, transactionLimit);

    res.json({
        success: true,
        message: 'Spending rules saved successfully!',
        rules: { monthlyLimit, transactionLimit }
    });
});

// Calculate completed spending for the current month
function getMonthlySpent() {
    const result = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE status = 'COMPLETED'
        AND currency = 'USD'
        AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `).get();

    return result.total;
}

// Evaluate whether a purchase fits the user's spending rules
function evaluatePurchase(price, rules, monthlySpent) {
    if (!Number.isFinite(price) || price <= 0) {
        return {
            decision: 'BLOCKED',
            reason: 'Invalid product price.'
        };
    }

    const remainingBudget = rules.monthlyLimit - monthlySpent;

    if (price > remainingBudget) {
        return {
            decision: 'BLOCKED',
            reason: 'Purchase exceeds your remaining monthly budget.'
        };
    }

    if (price > rules.transactionLimit) {
        return {
            decision: 'NEEDS_APPROVAL',
            reason: 'Purchase exceeds your per-transaction limit.'
        };
    }

    return {
        decision: 'ALLOWED',
        reason: 'Purchase is within your spending limits.'
    };
}

// Retrieve the latest product details from Channel3
async function getChannel3Product(productId) {
    const apiKey = process.env.CHANNEL3_API_KEY;

    if (!apiKey) {
        throw new Error('Channel3 API key is not configured.');
    }

    const response = await fetch(
        `https://api.trychannel3.com/v1/products/${encodeURIComponent(productId)}`,
        {
            headers: {
                'x-api-key': apiKey
            }
        }
    );

    if (!response.ok) {
        throw new Error('Unable to retrieve the latest product details.');
    }

    const product = await response.json();

    if (product.id !== productId) {
        throw new Error('Product verification failed.');
    }

    return product;
}

// Search products using Channel3
app.post('/api/products/search', async (req, res) => {
    try {
        const { query } = req.body;

        if (typeof query !== 'string' || !query.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a product to search for.'
            });
        }

        const apiKey = process.env.CHANNEL3_API_KEY;

        if (!apiKey) {
            return res.status(500).json({
                success: false,
                message: 'Product search is not configured.'
            });
        }

        const response = await fetch(
            'https://api.trychannel3.com/v1/search',
            {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    query: query.trim(),
                    config: { mode: 'agentic' },
                    limit: 5
                })
            }
        );

        if (!response.ok) {
            console.error('Channel3 request failed:', response.status);

            return res.status(502).json({
                success: false,
                message: 'Product search provider is temporarily unavailable.'
            });
        }

        const data = await response.json();

        const rulesRow = db.prepare(`
    SELECT monthly_limit, transaction_limit
    FROM spending_rules
    WHERE id = 1
`).get();

        const monthlySpent = getMonthlySpent();

        const products = (data.products || []).map((product) => {
            const offer = product.offers?.[0];
            const price = Number(offer?.price?.price);
            const currency = offer?.price?.currency;

            if (!rulesRow) {
                return {
                    ...product,
                    spendingDecision: {
                        decision: 'RULES_NOT_SET',
                        reason: 'Please configure your spending rules first.'
                    }
                };
            }

            if (currency !== 'USD' || !Number.isFinite(price) || price <= 0) {
                return {
                    ...product,
                    spendingDecision: {
                        decision: 'UNAVAILABLE',
                        reason: 'Price or currency could not be verified.'
                    }
                };
            }

            return {
                ...product,
                spendingDecision: {
                    ...evaluatePurchase(
                        price,
                        {
                            monthlyLimit: rulesRow.monthly_limit,
                            transactionLimit: rulesRow.transaction_limit
                        },
                        monthlySpent
                    ),
                    remainingBudget: Math.max(
                        0,
                        rulesRow.monthly_limit - monthlySpent
                    )
                }
            };
        });

        res.json({
            success: true,
            products
        });
    } catch (error) {
        console.error('Product search error:', error.message);

        res.status(500).json({
            success: false,
            message: 'Something went wrong while searching for products.'
        });
    }
});

// Get saved spending rules
app.get('/api/rules', (req, res) => {
    const rules = db.prepare(`
        SELECT monthly_limit, transaction_limit, updated_at
        FROM spending_rules
        WHERE id = 1
    `).get();

    if (!rules) {
        return res.json({
            success: true,
            rules: null
        });
    }

    res.json({
        success: true,
        rules: {
            monthlyLimit: rules.monthly_limit,
            transactionLimit: rules.transaction_limit,
            updatedAt: rules.updated_at
        }
    });
});


// Existing health-check route
app.get('/', (req, res) => {
    res.json({
        message: 'AgentCart backend is running!'
    });
});

// Generate a PayPal OAuth access token
async function generatePayPalAccessToken() {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    const baseUrl = process.env.PAYPAL_BASE_URL;

    if (!clientId || !clientSecret || !baseUrl) {
        throw new Error('PayPal credentials are not configured.');
    }

    const auth = Buffer.from(
        `${clientId}:${clientSecret}`
    ).toString('base64');

    const response = await fetch(
        `${baseUrl}/v1/oauth2/token`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error('PayPal authentication failed.');
    }

    return data.access_token;
}

// Test PayPal connection safely
app.get('/api/paypal/test', async (req, res) => {
    try {
        await generatePayPalAccessToken();

        res.json({
            success: true,
            message: 'PayPal Sandbox authentication successful!'
        });
    } catch (error) {
        console.error('PayPal connection error:', error.message);

        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`AgentCart server running on port ${PORT}`);
});
