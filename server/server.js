
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


// Create a PayPal order after checking the product and spending rules
app.post('/api/paypal/orders', async (req, res) => {
    let reservedTransactionId;

    try {
        const { productId, userApproved } = req.body;

        if (typeof productId !== 'string' || !productId.trim()) {
            return res.status(400).json({
                success: false,
                message: 'A valid product ID is required.'
            });
        }

        // Retrieve fresh product information from Channel3
        const product = await getChannel3Product(productId);

        const offer = product.offers?.find(
            (item) =>
                item.price?.currency === 'USD' &&
                item.availability === 'InStock' &&
                item.condition === 'new'
        );

        const price = Number(offer?.price?.price);

        if (!offer || !Number.isFinite(price) || price <= 0) {
            return res.status(400).json({
                success: false,
                message: 'A valid in-stock USD offer could not be found.'
            });
        }

        // Load the user's spending rules
        const rules = db.prepare(`
            SELECT monthly_limit, transaction_limit
            FROM spending_rules
            WHERE id = 1
        `).get();

        if (!rules) {
            return res.status(400).json({
                success: false,
                message: 'Please configure your spending rules first.'
            });
        }

        // Reserve the monthly budget while the PayPal order is pending
        const reserveBudget = db.transaction(() => {
            // Release abandoned reservations older than 30 minutes
            db.prepare(`
                UPDATE transactions
                SET status = 'EXPIRED'
                WHERE status = 'PENDING'
                AND created_at <= datetime('now', '-30 minutes')
            `).run();

            const spent = db.prepare(`
                SELECT COALESCE(SUM(amount), 0) AS total
                FROM transactions
                WHERE status IN ('COMPLETED', 'PENDING')
                AND currency = 'USD'
                AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
            `).get().total;

            const decision = evaluatePurchase(
                price,
                {
                    monthlyLimit: rules.monthly_limit,
                    transactionLimit: rules.transaction_limit
                },
                spent
            );

            if (decision.decision === 'BLOCKED') {
                return { blocked: true, decision };
            }

            if (
                decision.decision === 'NEEDS_APPROVAL' &&
                userApproved !== true
            ) {
                return { needsApproval: true, decision };
            }

            const result = db.prepare(`
                INSERT INTO transactions (product_name, amount, currency, status)
                VALUES (?, ?, 'USD', 'PENDING')
            `).run(product.title, price);

            return {
                transactionId: result.lastInsertRowid
            };
        });

        const reservation = reserveBudget();

        if (reservation.blocked) {
            return res.status(403).json({
                success: false,
                ...reservation.decision
            });
        }

        if (reservation.needsApproval) {
            return res.status(409).json({
                success: false,
                ...reservation.decision,
                message: 'Explicit purchase approval is required.'
            });
        }

        reservedTransactionId = reservation.transactionId;

        // Authenticate with PayPal
        const accessToken = await generatePayPalAccessToken();
        const baseUrl = process.env.PAYPAL_BASE_URL;
        const clientUrl = process.env.CLIENT_URL;

        if (!clientUrl) {
            throw new Error('Frontend URL is not configured.');
        }

        // Create the PayPal order
        const paypalResponse = await fetch(
            `${baseUrl}/v2/checkout/orders`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    intent: 'CAPTURE',
                    purchase_units: [{
                        reference_id: String(reservedTransactionId),
                        description: product.title,
                        amount: {
                            currency_code: 'USD',
                            value: price.toFixed(2)
                        }
                    }],
                    application_context: {
                        return_url: `${clientUrl}/?payment=success`,
                        cancel_url: `${clientUrl}/?payment=cancelled`
                    }
                })
            }
        );

        const paypalData = await paypalResponse.json();

        if (!paypalResponse.ok) {
            console.error('PayPal order error:', paypalData);
            throw new Error('PayPal could not create the order.');
        }

        const approvalLink = paypalData.links?.find(
            (link) => link.rel === 'approve'
        )?.href;

        if (!approvalLink) {
            throw new Error('PayPal approval link was not returned.');
        }

        // Save PayPal's order ID against our pending transaction
        db.prepare(`
            UPDATE transactions
            SET paypal_order_id = ?
            WHERE id = ?
        `).run(paypalData.id, reservedTransactionId);

        res.status(201).json({
            success: true,
            message: 'PayPal order created. Buyer approval is required.',
            orderID: paypalData.id,
            approvalUrl: approvalLink,
            transactionId: reservedTransactionId
        });

    } catch (error) {
        console.error('PayPal order creation error:', error.message);

        if (reservedTransactionId) {
            db.prepare(`
                UPDATE transactions
                SET status = 'FAILED'
                WHERE id = ? AND status = 'PENDING'
            `).run(reservedTransactionId);
        }

        res.status(500).json({
            success: false,
            message: 'Unable to create the PayPal order.'
        });
    }
});


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


// Capture an approved PayPal order
app.post('/api/paypal/orders/:orderId/capture', async (req, res) => {
    try {
        const { orderId } = req.params;

        // Find the matching pending transaction
        const transaction = db.prepare(`
            SELECT id, product_name, amount, currency, status
            FROM transactions
            WHERE paypal_order_id = ?
        `).get(orderId);

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found.'
            });
        }

        if (transaction.status === 'COMPLETED') {
            return res.json({
                success: true,
                message: 'This transaction is already completed.'
            });
        }

        if (transaction.status !== 'PENDING') {
            return res.status(409).json({
                success: false,
                message: 'This transaction cannot be captured.'
            });
        }

        const accessToken = await generatePayPalAccessToken();
        const baseUrl = process.env.PAYPAL_BASE_URL;

        // Ask PayPal for the latest order status
        const orderResponse = await fetch(
            `${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        const paypalOrder = await orderResponse.json();

        if (!orderResponse.ok) {
            throw new Error('Unable to verify PayPal order.');
        }

        if (paypalOrder.status !== 'APPROVED') {
            return res.status(409).json({
                success: false,
                message: 'Buyer approval has not been completed.'
            });
        }

        // Verify the order belongs to this transaction
        const orderUnit = paypalOrder.purchase_units?.find(
            (unit) => unit.reference_id === String(transaction.id)
        );

        if (
            !orderUnit ||
            orderUnit.amount?.currency_code !== transaction.currency ||
            orderUnit.amount?.value !== transaction.amount.toFixed(2)
        ) {
            return res.status(400).json({
                success: false,
                message: 'PayPal order details do not match our transaction.'
            });
        }

        // Capture the approved payment
        const captureResponse = await fetch(
            `${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({})
            }
        );

        const captureData = await captureResponse.json();

        if (!captureResponse.ok) {
            console.error('PayPal capture error:', captureData);

            return res.status(502).json({
                success: false,
                message: 'PayPal payment capture failed.'
            });
        }

        const captureStatus =
            captureData.purchase_units?.[0]?.payments?.captures?.[0]?.status;

        if (
            captureData.status !== 'COMPLETED' ||
            captureStatus !== 'COMPLETED'
        ) {
            return res.status(409).json({
                success: false,
                message: 'PayPal has not confirmed completed payment.'
            });
        }

        // Mark transaction completed only after PayPal confirms capture
        const update = db.prepare(`
            UPDATE transactions
            SET status = 'COMPLETED'
            WHERE id = ? AND status = 'PENDING'
        `).run(transaction.id);

        if (update.changes !== 1) {
            throw new Error('Unable to update transaction status.');
        }

        res.json({
            success: true,
            message: 'Payment captured successfully!',
            transactionId: transaction.id,
            orderID: orderId,
            status: 'COMPLETED'
        });

    } catch (error) {
        console.error('PayPal capture error:', error.message);

        res.status(500).json({
            success: false,
            message: 'Unable to complete PayPal payment.'
        });
    }
});


app.listen(PORT, () => {
    console.log(`AgentCart server running on port ${PORT}`);
});
