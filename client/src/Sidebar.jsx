
function Sidebar({ activePage, onNavigate }) {
    const pages = [
        'Dashboard',
        'AI Shopping',
        'Spending Rules',
        'Purchase Requests',
        'Transaction History'
    ]

    return (
        <aside className="sidebar">
            <h2>AgentCart<span>.</span></h2>

            <p className="sidebar-label">WORKSPACE</p>

            <nav>
                {pages.map((page) => (
                    <button
                        key={page}
                        className={activePage === page ? 'active' : ''}
                        onClick={() => onNavigate(page)}
                    >
                        {page}
                    </button>
                ))}
            </nav>

            <p className="sidebar-footer">
                AI Shopping. Your Rules.
            </p>
        </aside>
    )
}

export default Sidebar
