
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();
const Groq = require('groq-sdk');
const db = require('./turso');

// Initialize Groq only when an API key is available
const groq = process.env.GROQ_API_KEY
    ? new Groq({ apiKey: process.env.GROQ_API_KEY })
    : null;

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Save spending rules
app.post('/api/rules', async (req, res) => {
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

    try {
        await db.run(`
            INSERT INTO spending_rules (id, monthly_limit, transaction_limit)
            VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                monthly_limit = excluded.monthly_limit,
                transaction_limit = excluded.transaction_limit,
                updated_at = CURRENT_TIMESTAMP
        `, [monthlyLimit, transactionLimit]);

        res.json({
            success: true,
            message: 'Spending rules saved successfully!',
            rules: { monthlyLimit, transactionLimit }
        });
    } catch (error) {
        console.error('Error saving spending rules:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to save spending rules.'
        });
    }
});

// Calculate completed spending for the current month
async function getMonthlySpent() {
    const result = await db.get(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE status = 'COMPLETED'
        AND currency = 'USD'
        AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `);

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

function isRecognizedRetailer(domain) {
    const trustedDomains = [
        'macys.com',
        'selfridges.com',
        'walmart.com',
        'bhphotovideo.com',
        'bestbuy.com',
        'apple.com',
        'newegg.com',
        'microcenter.com',
        'adidas.com',
        'adidas.ca'
    ];

    if (typeof domain !== 'string' || !domain.trim()) {
        return false;
    }

    const normalizedDomain = domain
        .toLowerCase()
        .trim()
        .replace(/\.$/, '');

    if (
        normalizedDomain.includes('://') ||
        /[\/:@\s]/.test(normalizedDomain) ||
        !/^[a-z0-9.-]+$/.test(normalizedDomain) ||
        normalizedDomain.includes('..')
    ) {
        return false;
    }

    return trustedDomains.some(
        trustedDomain =>
            normalizedDomain === trustedDomain ||
            normalizedDomain.endsWith('.' + trustedDomain)
    );
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

        const rulesRow = await db.get(`
            SELECT monthly_limit, transaction_limit
            FROM spending_rules
            WHERE id = 1
        `);

        const monthlySpent = await getMonthlySpent();

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
app.get('/api/rules', async (req, res) => {
    try {
        const rules = await db.get(`
            SELECT monthly_limit, transaction_limit, updated_at
            FROM spending_rules
            WHERE id = 1
        `);

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
    } catch (error) {
        console.error('Error fetching spending rules:', error.message);
        res.status(500).json({
            success: false,
            message: 'Unable to fetch spending rules.'
        });
    }
});

// Get transaction history
app.get('/api/transactions', async (req, res) => {
    try {
        const transactions = await db.all(`
            SELECT
                id,
                product_name,
                amount,
                currency,
                status,
                paypal_order_id,
                created_at
            FROM transactions
            ORDER BY created_at DESC
        `);

        res.json({
            success: true,
            transactions
        });
    } catch (error) {
        console.error('Error fetching transactions:', error.message);
        res.status(500).json({
            success: false,
            message: 'Unable to fetch transaction history.'
        });
    }
});

// Get dashboard statistics
app.get('/api/dashboard', async (req, res) => {
    try {
        const stats = await db.get(`
            SELECT
                COALESCE(SUM(
                    CASE
                        WHEN status = 'COMPLETED'
                        AND currency = 'USD'
                        AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
                        THEN amount
                        ELSE 0
                    END
                ), 0) AS totalSpending,

                COUNT(
                    CASE
                        WHEN status = 'PENDING'
                        THEN 1
                    END
                ) AS pendingPayments,

                COUNT(
                    CASE
                        WHEN status = 'BLOCKED'
                        THEN 1
                    END
                ) AS blockedTransactions

            FROM transactions
        `);

        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Error fetching dashboard statistics:', error.message);
        res.status(500).json({
            success: false,
            message: 'Unable to fetch dashboard statistics.'
        });
    }
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

// Verify a purchase approval token
function verifyApprovalToken(submittedToken, storedHash) {
    if (
        typeof submittedToken !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(submittedToken) ||
        typeof storedHash !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(storedHash)
    ) {
        return false;
    }

    const submittedHash = crypto
        .createHash('sha256')
        .update(submittedToken)
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(submittedHash, 'hex'),
        Buffer.from(storedHash, 'hex')
    );
}
// Find and validate a pending purchase approval
async function getPendingApproval(approvalId, token) {
    const id = Number(approvalId);

    if (!Number.isSafeInteger(id) || id <= 0) {
        return { error: 'Invalid approval ID.' };
    }

    const approval = await db.get(`
        SELECT *
        FROM purchase_approvals
        WHERE id = ?
    `, [id]);

    if (!approval) {
        return { error: 'Approval request not found.' };
    }

    if (approval.status !== 'PENDING') {
        return { error: 'This approval request has already been used.' };
    }

    const expiryResult = await db.get(`
        SELECT datetime(?) <= datetime('now') AS expired
    `, [approval.expires_at]);

    if (expiryResult.expired) {
        await db.run(`
            UPDATE purchase_approvals
            SET status = 'EXPIRED'
            WHERE id = ? AND status = 'PENDING'
        `, [id]);

        return { error: 'This approval request has expired.' };
    }

    if (!verifyApprovalToken(token, approval.approval_token_hash)) {
        return { error: 'Invalid approval token.' };
    }

    return { approval };
}

// Get purchase approval requests
app.get('/api/purchase-approvals', async (req, res) => {
    try {
        // Mark expired requests
        await db.run(`
            UPDATE purchase_approvals
            SET status = 'EXPIRED'
            WHERE status = 'PENDING'
            AND expires_at <= datetime('now')
        `);

        const approvals = await db.all(`
            SELECT
                id,
                product_id,
                product_name,
                amount,
                status,
                expires_at,
                created_at
            FROM purchase_approvals
            ORDER BY created_at DESC
        `);

        res.json({
            success: true,
            approvals
        });
    } catch (error) {
        console.error('Error fetching purchase approvals:', error);

        res.status(500).json({
            success: false,
            message: 'Unable to fetch purchase approval requests.'
        });
    }
});


// Request approval for a purchase that exceeds the transaction limit
app.post('/api/purchase-approvals', async (req, res) => {
    try {
        const { productId } = req.body;

        if (typeof productId !== 'string' || !productId.trim()) {
            return res.status(400).json({
                success: false,
                message: 'A valid product ID is required.'
            });
        }

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

        // Verify the retailer before requesting purchase approval
        const retailerRecognized = isRecognizedRetailer(offer?.domain);

        if (
            !retailerRecognized &&
            req.body?.allowUnrecognizedRetailer !== true
        ) {
            return res.status(403).json({
                success: false,
                decision: 'UNVERIFIED_RETAILER',
                message: 'This retailer is not verified by AgentCart. User confirmation is required.'
            });
        }

        const rules = await db.get(`
    SELECT monthly_limit, transaction_limit
    FROM spending_rules
    WHERE id = 1
`);

        if (!rules) {
            return res.status(400).json({
                success: false,
                message: 'Please configure your spending rules first.'
            });
        }

        const monthlySpent = await getMonthlySpent();

        const decision = evaluatePurchase(
            price,
            {
                monthlyLimit: rules.monthly_limit,
                transactionLimit: rules.transaction_limit
            },
            monthlySpent
        );

        if (decision.decision !== 'NEEDS_APPROVAL') {
            return res.status(409).json({
                success: false,
                ...decision,
                message: 'This product does not require purchase approval.'
            });
        }

        const approvalToken = crypto.randomBytes(32).toString('hex');

        const approvalTokenHash = crypto
            .createHash('sha256')
            .update(approvalToken)
            .digest('hex');

        const approval = await db.run(`
    INSERT INTO purchase_approvals (
        product_id,
        product_name,
        amount,
        expires_at,
        approval_token_hash
    )
    VALUES (?, ?, ?, datetime('now', '+10 minutes'), ?)
`, [productId, product.title, price, approvalTokenHash]);

        res.status(201).json({
            success: true,
            message: 'Purchase approval requested.',
            approvalId: approval.lastInsertRowid,
            token: approvalToken,
            productName: product.title,
            amount: price
        });

    } catch (error) {
        console.error('Purchase approval error:', error.message);

        res.status(500).json({
            success: false,
            message: 'Unable to request purchase approval.'
        });
    }
});
// Approve a purchase and create its PayPal order
app.post('/api/purchase-approvals/:approvalId/approve', async (req, res) => {
    let reservedTransactionId;
    let processingApprovalId;

    try {
        const { approvalId } = req.params;
        const { token } = req.body;

        const result = await getPendingApproval(approvalId, token);

        if (result.error) {
            return res.status(409).json({
                success: false,
                message: result.error
            });
        }

        const approval = result.approval;
        processingApprovalId = approval.id;

        // Retrieve the latest product information
        const product = await getChannel3Product(approval.product_id);

        // Find a fresh, valid offer for the approved product
        const offer = product.offers?.find(
            (item) =>
                item.price?.currency === 'USD' &&
                item.availability === 'InStock' &&
                item.condition === 'new'
        );

        const currentPrice = Number(offer?.price?.price);

        if (!offer || !Number.isFinite(currentPrice) || currentPrice <= 0) {
            return res.status(400).json({
                success: false,
                message: 'A valid in-stock USD offer could not be found.'
            });
        }

        // Do not proceed if the price changed after the user requested approval
        if (Math.abs(currentPrice - approval.amount) > 0.001) {
            return res.status(409).json({
                success: false,
                message: 'The product price has changed. Please request approval again.'
            });
        }

        // Verify that the user confirmed an unrecognized retailer
        const retailerRecognized = isRecognizedRetailer(offer.domain);

        if (
            !retailerRecognized &&
            req.body?.allowUnrecognizedRetailer !== true
        ) {
            return res.status(403).json({
                success: false,
                decision: 'UNVERIFIED_RETAILER',
                message: 'This retailer is not verified by AgentCart. User confirmation is required.'
            });
        }

        const rules = await db.get(`
    SELECT monthly_limit, transaction_limit
    FROM spending_rules
    WHERE id = 1
`);

        if (!rules) {
            return res.status(400).json({
                success: false,
                message: 'Please configure your spending rules first.'
            });
        }

        // Reserve the approved purchase only once
        const reservation = await db.transactionAsync(async (tx) => {
            // Expire old pending transactions
            await tx.run(`
        UPDATE transactions
        SET status = 'EXPIRED'
        WHERE status = 'PENDING'
        AND created_at <= datetime('now', '-30 minutes')
    `);

            // Calculate current monthly spending
            const spentResult = await tx.get(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE status IN ('COMPLETED', 'PENDING')
        AND currency = 'USD'
        AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `);

            const latestSpent = spentResult.total;

            // Recheck the spending policy
            const latestDecision = evaluatePurchase(
                currentPrice,
                {
                    monthlyLimit: rules.monthly_limit,
                    transactionLimit: rules.transaction_limit
                },
                latestSpent
            );

            if (latestDecision.decision !== 'NEEDS_APPROVAL') {
                return {
                    error: 'Spending rules or available budget have changed. Please review the purchase again.'
                };
            }

            // Mark this approval as being processed
            const updated = await tx.run(`
        UPDATE purchase_approvals
        SET status = 'PROCESSING'
        WHERE id = ?
        AND status = 'PENDING'
        AND expires_at > datetime('now')
    `, [approval.id]);

            if (updated.changes !== 1) {
                return {
                    error: 'This approval request is no longer available.'
                };
            }

            // Reserve a pending transaction
            const transaction = await tx.run(`
        INSERT INTO transactions (
            product_name,
            amount,
            currency,
            status
        )
        VALUES (?, ?, 'USD', 'PENDING')
    `, [product.title, currentPrice]);

            return {
                transactionId: transaction.lastInsertRowid
            };
        })();

        if (reservation.error) {
            return res.status(409).json({
                success: false,
                message: reservation.error
            });
        }

        reservedTransactionId = reservation.transactionId;

        // Create the PayPal order
        const accessToken = await generatePayPalAccessToken();
        const baseUrl = process.env.PAYPAL_BASE_URL;
        const clientUrl = process.env.CLIENT_URL;

        if (!clientUrl) {
            throw new Error('Frontend URL is not configured.');
        }

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
                            value: currentPrice.toFixed(2)
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

        // Save the PayPal order and consume the approval request
        await db.transactionAsync(async (tx) => {
            const transactionUpdate = await tx.run(`
        UPDATE transactions
        SET paypal_order_id = ?
        WHERE id = ? AND status = 'PENDING'
    `, [paypalData.id, reservedTransactionId]);

            const approvalUpdate = await tx.run(`
        UPDATE purchase_approvals
        SET status = 'APPROVED'
        WHERE id = ? AND status = 'PROCESSING'
    `, [approval.id]);

            if (
                transactionUpdate.changes !== 1 ||
                approvalUpdate.changes !== 1
            ) {
                throw new Error('Unable to finalize the approved purchase.');
            }
        })();

        res.status(201).json({
            success: true,
            message: 'Purchase approved. PayPal buyer approval is required.',
            orderID: paypalData.id,
            approvalUrl: approvalLink,
            transactionId: reservedTransactionId
        });

    } catch (error) {
        console.error('Purchase approval error:', error.message);

        if (reservedTransactionId) {
            await db.run(`
        UPDATE transactions
        SET status = 'FAILED'
        WHERE id = ? AND status = 'PENDING'
    `, [reservedTransactionId]);
        }

        if (processingApprovalId) {
            await db.run(`
        UPDATE purchase_approvals
        SET status = 'FAILED'
        WHERE id = ? AND status = 'PROCESSING'
    `, [processingApprovalId]);
        }

        res.status(500).json({
            success: false,
            message: 'Unable to approve the purchase or create its PayPal order.'
        });
    }
});

// Create a PayPal order after checking the product and spending rules
app.post('/api/paypal/orders', async (req, res) => {
    let reservedTransactionId;

    try {
        const { productId } = req.body;

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
        console.log('[PAYPAL DEBUG] Product:', {
            productId,
            productName: product.title,
            price,
            retailer: offer?.domain
        });

        if (!offer || !Number.isFinite(price) || price <= 0) {
            return res.status(400).json({
                success: false,
                message: 'A valid in-stock USD offer could not be found.'
            });
        }
        // Verify the retailer before allowing the purchase
        const retailerRecognized = isRecognizedRetailer(offer?.domain);

        if (
            !retailerRecognized &&
            req.body?.allowUnrecognizedRetailer !== true
        ) {
            return res.status(403).json({
                success: false,
                decision: 'UNVERIFIED_RETAILER',
                message: 'This retailer is not verified by AgentCart. User confirmation is required.'
            });
        }

        // Load the user's spending rules
        const rules = await db.get(`
    SELECT monthly_limit, transaction_limit
    FROM spending_rules
    WHERE id = 1
`);

        if (!rules) {
            return res.status(400).json({
                success: false,
                message: 'Please configure your spending rules first.'
            });
        }

        // Reserve the monthly budget while the PayPal order is pending
        const reservation = await db.transactionAsync(async (tx) => {
            // Release abandoned reservations older than 30 minutes
            await tx.run(`
        UPDATE transactions
        SET status = 'EXPIRED'
        WHERE status = 'PENDING'
        AND created_at <= datetime('now', '-30 minutes')
    `);

            // Count completed and pending purchases for this month
            const spentResult = await tx.get(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE status IN ('COMPLETED', 'PENDING')
        AND currency = 'USD'
        AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `);

            const monthlySpent = Number(spentResult.total);

            const decision = evaluatePurchase(
                price,
                {
                    monthlyLimit: rules.monthly_limit,
                    transactionLimit: rules.transaction_limit
                },
                monthlySpent
            );
            console.log('[PAYPAL DEBUG] Policy:', {
                monthlyLimit: rules.monthly_limit,
                transactionLimit: rules.transaction_limit,
                monthlySpent,
                decision: decision.decision,
                reason: decision.reason
            });

            if (decision.decision === 'BLOCKED') {
                return { blocked: true, decision };
            }

            if (decision.decision === 'NEEDS_APPROVAL') {
                return { needsApproval: true, decision };
            }

            const result = await tx.run(`
        INSERT INTO transactions (product_name, amount, currency, status)
        VALUES (?, ?, 'USD', 'PENDING')
    `, [product.title, price]);

            return {
                transactionId: result.lastInsertRowid
            };
        })();

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
        await db.run(`
    UPDATE transactions
    SET paypal_order_id = ?
    WHERE id = ?
`, [paypalData.id, reservedTransactionId]);

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
            await db.run(`
        UPDATE transactions
        SET status = 'FAILED'
        WHERE id = ? AND status = 'PENDING'
    `, [reservedTransactionId]);
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
        const transaction = await db.get(`
    SELECT id, product_name, amount, currency, status
    FROM transactions
    WHERE paypal_order_id = ?
`, [orderId]);

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
        const update = await db.run(`
    UPDATE transactions
    SET status = 'COMPLETED'
    WHERE id = ? AND status = 'PENDING'
`, [transaction.id]);

        if (update.changes !== 1) {
            const latestTransaction = await db.get(`
        SELECT status
        FROM transactions
        WHERE id = ?
    `, [transaction.id]);

            if (latestTransaction?.status === 'COMPLETED') {
                return res.json({
                    success: true,
                    message: 'This transaction is already completed.',
                    transactionId: transaction.id,
                    orderID: orderId,
                    status: 'COMPLETED'
                });
            }

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


// Interpret shopping requests using Groq, with a local fallback
app.post('/api/agent/interpret', async (req, res) => {
    const interpretLocally = (text) => {
        const budgetMatch = text.match(
            /(?:under|below|less than|up to|upto|within|maximum(?: of)?|max(?:imum)?(?: budget)?(?: of)?)\s*\$?\s*(\d+(?:\.\d+)?)/i
        ) || text.match(/\$\s*(\d+(?:\.\d+)?)/);

        const maxPriceUSD = budgetMatch
            ? Number(budgetMatch[1])
            : null;

        const preferenceWords = [
            'wireless',
            'bluetooth',
            'noise cancelling',
            'noise cancellation',
            'waterproof',
            'lightweight',
            'gaming',
            'portable',
            'over-ear',
            'on-ear'
        ];

        const preferences = preferenceWords.filter(
            preference => text.toLowerCase().includes(preference)
        );

        let searchQuery = text
            .replace(
                /(?:under|below|less than|up to|upto|within|maximum(?: of)?|max(?:imum)?(?: budget)?(?: of)?)\s*\$?\s*\d+(?:\.\d+)?/gi,
                ' '
            )
            .replace(/\$\s*\d+(?:\.\d+)?/g, ' ')
            .replace(/\b(?:find|search|show|looking for|buy|get me|i need|i want|please)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!searchQuery) searchQuery = text;

        return { searchQuery, maxPriceUSD, preferences };
    };

    try {
        const { message } = req.body;

        if (
            typeof message !== 'string' ||
            !message.trim() ||
            message.length > 500
        ) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a shopping request (maximum 500 characters).'
            });
        }

        const text = message.trim();

        // Use Groq as the primary AI interpreter
        if (groq) {
            try {
                const completion = await groq.chat.completions.create({
                    model: 'openai/gpt-oss-20b',
                    messages: [
                        {
                            role: 'system',
                            content: `Extract shopping intent from the user's message.
Return only the requested structured fields.
searchQuery must contain the product being searched for, without budget instructions.
maxPriceUSD must be a positive USD budget if explicitly provided, otherwise null.
Do not convert currencies or invent a budget.
preferences must contain relevant product preferences explicitly mentioned by the user.`
                        },
                        {
                            role: 'user',
                            content: text
                        }
                    ],
                    response_format: {
                        type: 'json_schema',
                        json_schema: {
                            name: 'shopping_intent',
                            strict: true,
                            schema: {
                                type: 'object',
                                properties: {
                                    searchQuery: { type: 'string' },
                                    maxPriceUSD: {
                                        type: ['number', 'null']
                                    },
                                    preferences: {
                                        type: 'array',
                                        items: { type: 'string' }
                                    }
                                },
                                required: [
                                    'searchQuery',
                                    'maxPriceUSD',
                                    'preferences'
                                ],
                                additionalProperties: false
                            }
                        }
                    }
                });

                const result = JSON.parse(
                    completion.choices[0].message.content
                );

                if (
                    typeof result.searchQuery === 'string' &&
                    result.searchQuery.trim() &&
                    result.searchQuery.length <= 200 &&
                    (
                        result.maxPriceUSD === null ||
                        (
                            typeof result.maxPriceUSD === 'number' &&
                            Number.isFinite(result.maxPriceUSD) &&
                            result.maxPriceUSD > 0
                        )
                    ) &&
                    Array.isArray(result.preferences) &&
                    result.preferences.every(
                        item => typeof item === 'string'
                    )
                ) {
                    const interpretation = {
                        searchQuery: result.searchQuery.trim(),
                        maxPriceUSD: result.maxPriceUSD,
                        preferences: result.preferences.slice(0, 10),
                        mode: 'groq',
                        provider: 'groq'
                    };

                    return res.json({
                        success: true,
                        mode: 'groq',
                        interpretation
                    });
                }

                throw new Error('Groq returned an invalid interpretation.');
            } catch (groqError) {
                console.error(
                    'Groq interpretation failed:',
                    groqError.message
                );
            }
        }


        // Try Gemini if Groq is unavailable or returns invalid data
        if (process.env.GEMINI_API_KEY) {
            try {
                const geminiResponse = await fetch(
                    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': process.env.GEMINI_API_KEY
                        },
                        body: JSON.stringify({
                            contents: [{
                                role: 'user',
                                parts: [{
                                    text: `Extract shopping intent from this request:
"${text}"

Return the product search query without budget instructions.
Only include a USD budget if explicitly mentioned.
Do not convert currencies or invent preferences.
Include relevant preferences explicitly mentioned by the user.`
                                }]
                            }],
                            generationConfig: {
                                responseMimeType: 'application/json',
                                responseSchema: {
                                    type: 'OBJECT',
                                    properties: {
                                        searchQuery: { type: 'STRING' },
                                        maxPriceUSD: {
                                            type: 'NUMBER',
                                            nullable: true
                                        },
                                        preferences: {
                                            type: 'ARRAY',
                                            items: { type: 'STRING' }
                                        }
                                    },
                                    required: [
                                        'searchQuery',
                                        'maxPriceUSD',
                                        'preferences'
                                    ]
                                }
                            }
                        })
                    }
                );

                if (!geminiResponse.ok) {
                    const errorData = await geminiResponse.json();
                    throw new Error(
                        errorData.error?.message || 'Gemini API request failed.'
                    );
                }

                const geminiData = await geminiResponse.json();

                const responseText =
                    geminiData.candidates?.[0]?.content?.parts
                        ?.map(part => part.text || '')
                        .join('');

                if (!responseText) {
                    throw new Error('Gemini returned an empty response.');
                }

                const result = JSON.parse(responseText);

                if (
                    typeof result.searchQuery === 'string' &&
                    result.searchQuery.trim() &&
                    result.searchQuery.length <= 200 &&
                    (
                        result.maxPriceUSD === null ||
                        (
                            typeof result.maxPriceUSD === 'number' &&
                            Number.isFinite(result.maxPriceUSD) &&
                            result.maxPriceUSD > 0
                        )
                    ) &&
                    Array.isArray(result.preferences) &&
                    result.preferences.every(
                        item => typeof item === 'string'
                    )
                ) {
                    const interpretation = {
                        searchQuery: result.searchQuery.trim(),
                        maxPriceUSD: result.maxPriceUSD,
                        preferences: result.preferences.slice(0, 10),
                        mode: 'gemini',
                        provider: 'gemini'
                    };

                    console.log('Shopping interpretation succeeded with Gemini.');

                    return res.json({
                        success: true,
                        mode: 'gemini',
                        interpretation
                    });
                }

                throw new Error('Gemini returned an invalid interpretation.');

            } catch (geminiError) {
                console.error(
                    'Gemini interpretation failed:',
                    geminiError.message
                );
            }
        }

        // Use the existing local parser if both AI providers fail

        const interpretation = {
            ...interpretLocally(text),
            mode: 'local_fallback',
            provider: 'local'
        };

        return res.json({
            success: true,
            mode: 'local_fallback',
            interpretation
        });

    } catch (error) {
        console.error('Shopping interpretation error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Unable to understand the shopping request.'
        });
    }
});




app.listen(PORT, () => {
    console.log(`AgentCart server running on port ${PORT}`);
});
