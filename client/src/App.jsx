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

  useEffect(() => {
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
  }, [])

  function handleSaveRules() {
    if (!monthlyLimit || !transactionLimit) {
      setError('Please enter both spending limits.');
      setSaved(false);
      return;
    }

    if (Number(monthlyLimit) <= 0 || Number(transactionLimit) <= 0) {
      setError('Spending limits must be greater than zero.');
      setSaved(false);
      return;
    }

    setError('');
    setSaved(true);
  }

  return (
    <div className="dashboard-layout">
      <Sidebar
        activePage={activePage}
        onNavigate={setActivePage}
      />

      <main className="main-content">

        <h1>{activePage === 'Dashboard' ? 'Welcome to AgentCart' : activePage}</h1>
        <p>Your AI can shop. You stay in control.</p>
        <p>Backend Status: {backendStatus}</p>

        {activePage === 'Dashboard' && (
          <>

            <div className="overview-cards">
              <div className="overview-card">
                <h3>Total Spending</h3>
                <p>$0.00</p>
              </div>

              <div className="overview-card">
                <h3>Pending Approvals</h3>
                <p>0</p>
              </div>

              <div className="overview-card">
                <h3>Blocked Transactions</h3>
                <p>0</p>
              </div>
            </div>


            <div className="recent-activity">
              <h2>Recent Activity</h2>
              <p>No transactions yet. Your AI shopping activity will appear here.</p>
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
      </main>
    </div>
  )
}

export default App