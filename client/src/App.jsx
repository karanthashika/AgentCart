import './App.css'
import { useState } from 'react'
import Sidebar from './Sidebar'

function App() {
  const [activePage, setActivePage] = useState('Dashboard')

  return (
    <div className="dashboard-layout">
      <Sidebar
        activePage={activePage}
        onNavigate={setActivePage}
      />

      <main className="main-content">

        <h1>{activePage === 'Dashboard' ? 'Welcome to AgentCart' : activePage}</h1>
        <p>Your AI can shop. You stay in control.</p>

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
      </main>
    </div>
  )
}

export default App