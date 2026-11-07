
function Sidebar(props) {
    return (
        <aside className="sidebar">
            <h2>AgentCart</h2>

            <nav>
                <button onClick={() => props.onNavigate('Dashboard')}>
                    Dashboard
                </button>
                <button onClick={() => props.onNavigate('AI Shopping')}>
                    AI Shopping
                </button>
                <button onClick={() => props.onNavigate('Spending Rules')}>
                    Spending Rules
                </button>

                <button onClick={() => props.onNavigate('Purchase Requests')}>
                    Purchase Requests
                </button>

                <button onClick={() => props.onNavigate('Transaction History')}>
                    Transaction History
                </button>
            </nav>

            <p className="sidebar-footer">AI Shopping. Your Rules.</p>
        </aside>
    )
}

export default Sidebar
