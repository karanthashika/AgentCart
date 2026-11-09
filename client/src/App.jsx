import './App.css'
import { useState, useEffect } from 'react'
import Sidebar from './Sidebar'

function App() {
  const [activePage, setActivePage] = useState('Dashboard')
  const [monthlyLimit, setMonthlyLimit] = useState('')
  const [transactionLimit, setTransactionLimit] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('');
  const [backendStatus, setBackendStatus] = useState('Checking backend...')
  // AI Shopping state
  const [shoppingQuery, setShoppingQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [products, setProducts] = useState([])
  const [transactions, setTransactions] = useState([])
  const [transactionsError, setTransactionsError] = useState('')
  const [dashboardStats, setDashboardStats] = useState({
    totalSpending: 0,
    pendingPayments: 0,
    blockedTransactions: 0
  })
  const [dashboardError, setDashboardError] = useState('')
  const [purchaseError, setPurchaseError] = useState('')
  const [purchaseMessage, setPurchaseMessage] = useState('')
  const [isCreatingOrder, setIsCreatingOrder] = useState(false)
  const [approvalId, setApprovalId] = useState(null)
  const [approvalToken, setApprovalToken] = useState('')
  const [approvalProductId, setApprovalProductId] = useState(null)
  async function handlePurchase(product) {
    setPurchaseError('')
    setPurchaseMessage('')
    setApprovalId(null)
    setApprovalToken('')
    setIsCreatingOrder(true)

    try {
      const response = await fetch(
        'http://localhost:5000/api/paypal/orders',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            productId: product.id
          })
        }
      )

      const data = await response.json()

      if (response.status === 409 && data.decision === 'NEEDS_APPROVAL') {
        const approvalResponse = await fetch(
          'http://localhost:5000/api/purchase-approvals',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              productId: product.id
            })
          }
        )

        const approvalData = await approvalResponse.json()

        if (!approvalResponse.ok) {
          throw new Error(
            approvalData.message || 'Unable to request purchase approval.'
          )
        }

        setApprovalId(approvalData.approvalId)
        setApprovalToken(approvalData.token)
        setApprovalProductId(product.id)

        setPurchaseMessage(
          `Approval required for ${approvalData.productName} ($${approvalData.amount}).`
        )

        return
      }

      if (!response.ok) {
        throw new Error(
          data.reason || data.message || 'Unable to create PayPal order.'
        )
      }

      setPurchaseMessage('Redirecting to PayPal...')
      window.location.href = data.approvalUrl

    } catch (error) {
      setPurchaseError(error.message)
    } finally {
      setIsCreatingOrder(false)
    }
  }

  async function handleApprovePurchase() {
    setPurchaseError('')
    setPurchaseMessage('')
    setIsCreatingOrder(true)

    try {
      const response = await fetch(
        `http://localhost:5000/api/purchase-approvals/${approvalId}/approve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            token: approvalToken
          })
        }
      )

      const data = await response.json()

      if (!response.ok) {
        throw new Error(
          data.message || 'Unable to approve purchase.'
        )
      }

      setPurchaseMessage('Redirecting to PayPal...')
      window.location.href = data.approvalUrl

    } catch (error) {
      setPurchaseError(error.message)
    } finally {
      setIsCreatingOrder(false)
    }
  }

  useEffect(() => {
    // Check backend connection
    fetch('http://localhost:5000')
      .then((response) => {
        if (!response.ok) {
          throw new Error('Backend connection failed')
        }
        return response.json()
      })
      .then((data) => {
        setBackendStatus(data.message)
      })
      .catch(() => {
        setBackendStatus('Backend is not connected')
      })

    // Load saved spending rules
    fetch('http://localhost:5000/api/rules')
      .then((response) => {
        if (!response.ok) {
          throw new Error('Could not load spending rules')
        }
        return response.json()
      })
      .then((data) => {
        if (data.rules) {
          setMonthlyLimit(String(data.rules.monthlyLimit))
          setTransactionLimit(String(data.rules.transactionLimit))
        }
      })
      .catch((error) => {
        console.error('Error loading spending rules:', error)
      })
  }, [])

  async function loadTransactions() {
    try {
      const response = await fetch('http://localhost:5000/api/transactions')
      const data = await response.json()

      if (!data.success) {
        throw new Error('Unable to load transactions.')
      }

      setTransactions(data.transactions)
    } catch (error) {
      setTransactionsError(error.message)
    }
  }

  useEffect(() => {
    loadTransactions()
  }, [])

  async function loadDashboardStats() {
    try {
      const response = await fetch('http://localhost:5000/api/dashboard')
      const data = await response.json()

      if (!data.success) {
        throw new Error('Unable to load dashboard statistics.')
      }

      setDashboardStats(data.stats)
    } catch (error) {
      setDashboardError(error.message)
    }
  }

  useEffect(() => {
    loadDashboardStats()
  }, [])

  useEffect(() => {
    async function handlePayPalReturn() {
      const params = new URLSearchParams(window.location.search)
      const paymentStatus = params.get('payment')
      const orderId = params.get('token')

      if (paymentStatus === 'cancelled') {
        setPurchaseMessage('Payment was cancelled. No payment was captured.')
        window.history.replaceState({}, '', '/')
        return
      }

      if (paymentStatus !== 'success' || !orderId) {
        return
      }

      try {
        setIsCreatingOrder(true)

        const response = await fetch(
          `http://localhost:5000/api/paypal/orders/${encodeURIComponent(orderId)}/capture`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )

        const data = await response.json()

        if (!data.success) {
          throw new Error(data.message || 'Payment capture failed.')
        }

        setPurchaseMessage('Payment completed successfully!')
        await loadTransactions()
        await loadDashboardStats()

      } catch (error) {
        setPurchaseError(error.message)
      } finally {
        setIsCreatingOrder(false)
        window.history.replaceState({}, '', '/')
      }
    }

    handlePayPalReturn()
  }, [])

  async function handleSaveRules() {
    if (!monthlyLimit || !transactionLimit) {
      setError('Please enter both spending limits.');
      setSaved(false);
      return;
    }

    const monthly = Number(monthlyLimit);
    const transaction = Number(transactionLimit);

    if (monthly <= 0 || transaction <= 0) {
      setError('Spending limits must be greater than zero.');
      setSaved(false);
      return;
    }

    if (transaction > monthly) {
      setError('Per transaction limit cannot exceed monthly limit.');
      setSaved(false);
      return;
    }

    setError('');
    setSaved(false);

    try {
      const response = await fetch('http://localhost:5000/api/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          monthlyLimit: monthly,
          transactionLimit: transaction
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to save spending rules.');
      }

      setSaved(true);
    } catch (error) {
      setError(error.message || 'Could not connect to backend.');
    }
  }


  async function handleProductSearch() {
    if (!shoppingQuery.trim()) {
      setSearchError('Please enter a product to search for.')
      return
    }

    setIsSearching(true)
    setSearchError('')
    setProducts([])

    try {
      const response = await fetch(
        'http://localhost:5000/api/products/search',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: shoppingQuery
          })
        }
      )

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Product search failed.')
      }

      setProducts(data.products || [])

    } catch (error) {
      setSearchError(error.message || 'Could not connect to AgentCart.')
    } finally {
      setIsSearching(false)
    }
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
      'microcenter.com'
    ]

    if (!domain) return false

    const normalizedDomain = domain.toLowerCase().trim()

    return trustedDomains.some(
      (trustedDomain) =>
        normalizedDomain === trustedDomain ||
        normalizedDomain.endsWith('.' + trustedDomain)
    )
  }


  function isAllowedProductLink(url) {
    try {
      const parsedUrl = new URL(url)

      if (parsedUrl.protocol !== 'https:') {
        return false
      }

      const allowedDomains = [
        'buy.trychannel3.com',
        'macys.com',
        'selfridges.com',
        'walmart.com',
        'bhphotovideo.com',
        'bestbuy.com',
        'apple.com',
        'newegg.com',
        'microcenter.com'
      ]

      return allowedDomains.some(
        (domain) =>
          parsedUrl.hostname === domain ||
          parsedUrl.hostname.endsWith('.' + domain)
      )
    } catch {
      return false
    }
  }
  return (
    <div className="dashboard-layout">
      <Sidebar
        activePage={activePage}
        onNavigate={setActivePage}
      />

      <main className="main-content">


        {activePage === 'AI Shopping' && (
          <div className="ai-shopping">
            <h2>AI Shopping Assistant</h2>
            <p>Tell AgentCart what you're looking for.</p>

            <div className="search-container">
              <input
                type="text"
                placeholder="e.g. Wireless headphones under $100"
                value={shoppingQuery}
                onChange={(e) => setShoppingQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleProductSearch()
                }}
              />

              <button
                onClick={handleProductSearch}
                disabled={isSearching}
              >
                {isSearching ? 'Searching...' : 'Search Products'}
              </button>
            </div>

            {searchError && (
              <p className="error-message">{searchError}</p>
            )}

            {isSearching && <p>Finding products for you...</p>}


            {products.length > 0 && (
              <>
                {purchaseError && (
                  <p className="retailer-warning" role="alert">
                    {purchaseError}
                  </p>
                )}

                {purchaseMessage && (
                  <p className="purchase-message">
                    {purchaseMessage}
                  </p>
                )}

                <div className="product-grid">

                  {products.map((product) => {
                    const offer = product.offers?.[0]
                    const productUrl = offer?.url
                    const mainImage =
                      product.images?.find((image) => image.is_main_image)
                      || product.images?.[0]

                    const imageUrl = mainImage?.cleaned_url || mainImage?.url
                    const brand = product.brands?.[0]?.name
                    const retailerDomain = offer?.domain
                    const retailerRecognized = isRecognizedRetailer(retailerDomain)

                    return (
                      <div className="product-card" key={product.id}>
                        {imageUrl && (
                          <img src={imageUrl} alt={product.title} />
                        )}

                        <h3>{product.title}</h3>

                        {brand && <p>Brand: {brand}</p>}

                        {product.description && (
                          <p>{product.description}</p>
                        )}

                        {offer && (
                          <>
                            <h3>
                              {offer.price?.currency || '$'}{' '}
                              {offer.price?.price ?? 'Price unavailable'}
                            </h3>

                            <p>Retailer: {retailerDomain || 'Unknown retailer'}</p>
                            {product.spendingDecision && (
                              <div className="spending-decision">
                                <strong>
                                  Spending Decision: {product.spendingDecision.decision}
                                </strong>

                                <p>{product.spendingDecision.reason}</p>
                              </div>
                            )}

                            <p className={retailerRecognized ? 'retailer-trusted' : 'retailer-warning'}>
                              {retailerRecognized
                                ? '✓ Recognized retailer'
                                : '⚠ Retailer needs verification'}
                            </p>

                            {productUrl && isAllowedProductLink(productUrl) ? (
                              <>
                                <a
                                  href={productUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  View Product
                                </a>

                                <button
                                  onClick={() => handlePurchase(product)}
                                  disabled={isCreatingOrder}
                                >
                                  {isCreatingOrder ? 'Creating Order...' : 'Buy with PayPal'}
                                </button>
                                {approvalProductId === product.id && approvalId && (
                                  <button
                                    onClick={handleApprovePurchase}
                                    disabled={isCreatingOrder}
                                  >
                                    {isCreatingOrder ? 'Processing...' : 'Approve Purchase'}
                                  </button>
                                )}
                              </>
                            ) : (
                              <p className="retailer-warning">
                                ⚠ Product link could not be verified
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )}
        <h1>{activePage === 'Dashboard' ? 'Welcome to AgentCart' : activePage}</h1>
        <p>Your AI can shop. You stay in control.</p>
        <p>Backend Status: {backendStatus}</p>

        {activePage === 'Dashboard' && (
          <>

            <div className="overview-cards">
              <div className="overview-card">
                <h3>Total Spending This Month</h3>
                <p>${Number(dashboardStats.totalSpending).toFixed(2)}</p>
              </div>

              <div className="overview-card">
                <h3>Pending Payments</h3>
                <p>{dashboardStats.pendingPayments}</p>
              </div>

              <div className="overview-card">
                <h3>Blocked Transactions</h3>
                <p>{dashboardStats.blockedTransactions}</p>
              </div>
            </div>


            <div className="recent-activity">
              <h2>Recent Activity</h2>

              {transactionsError && (
                <p className="error-message">{transactionsError}</p>
              )}

              {!transactionsError && transactions.length === 0 && (
                <p>No transactions yet. Your AI shopping activity will appear here.</p>
              )}

              {transactions.slice(0, 5).map((transaction) => (
                <div className="activity-item" key={transaction.id}>
                  <div>
                    <strong>{transaction.product_name}</strong>
                    <p>{transaction.created_at}</p>
                  </div>

                  <div>
                    <strong>
                      {transaction.currency} {Number(transaction.amount).toFixed(2)}
                    </strong>
                    <p>{transaction.status}</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {activePage === 'Spending Rules' && (
          <div className="spending-rules">
            <h2>Spending Rules</h2>
            <p>Set limits for your AI shopping agent.</p>

            <div className="rule-card">
              <label>Monthly Spending Limit ($)</label>
              <input
                type="number"
                placeholder="Enter monthly limit"
                value={monthlyLimit}
                onChange={(e) => setMonthlyLimit(e.target.value)}
              />
            </div>

            <div className="rule-card">
              <label>Per Transaction Limit ($)</label>
              <input
                type="number"
                placeholder="Enter per transaction limit"
                value={transactionLimit}
                onChange={(e) => setTransactionLimit(e.target.value)}
              />
            </div>
            <button
              className="save-rules-btn"
              onClick={handleSaveRules}
            >
              Save Rules
            </button>
            {saved && (
              <p className="success-message">
                Rules saved successfully!
              </p>
            )}
            {error && (
              <p className="error-message">
                {error}
              </p>
            )}
          </div>
        )}
        {activePage === 'Transaction History' && (
          <div className="transaction-history">
            <h2>Transaction History</h2>
            <p>View your completed and pending purchases.</p>

            {transactionsError && (
              <p className="error-message">{transactionsError}</p>
            )}

            {transactions.length === 0 && !transactionsError && (
              <p>No transactions found.</p>
            )}

            {transactions.length > 0 && (
              <div className="transactions-list">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Date</th>
                    </tr>
                  </thead>

                  <tbody>
                    {transactions.map((transaction) => (
                      <tr key={transaction.id}>
                        <td>{transaction.product_name}</td>
                        <td>
                          {transaction.currency} {transaction.amount.toFixed(2)}
                        </td>
                        <td>{transaction.status}</td>
                        <td>{transaction.created_at}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

export default App