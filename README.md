# AgentCart 🛒

### The Trust Layer for AI-Powered Shopping Agents

AgentCart is an AI-powered shopping application that enables users to make purchases through natural-language requests while maintaining control over their spending.

It combines AI-assisted product discovery, retailer trust checks, backend-enforced spending policies, human approval workflows, and PayPal checkout to make autonomous shopping safer and more transparent.

**The core idea:** Let AI shop for you, but never let it spend beyond the rules you set.

##  Key Features ✨

- **AI-Powered Shopping:** Interpret natural-language shopping requests using Groq, with Gemini fallback.

- **Product Discovery:** Search for products through the Channel3 API.

- **Spending Policy Engine:** Enforce monthly and per-transaction spending limits.

- **Purchase Decisions:** Automatically classify purchases as `ALLOWED`, `NEEDS_APPROVAL`, or `BLOCKED`.

- **Retailer Trust Checks:** Identify unrecognized retailers and request user acknowledgment.

- **Human-in-the-Loop Approval:** Require explicit approval for purchases exceeding transaction limits.

- **PayPal Integration:** Create PayPal Sandbox orders and capture payments after buyer authorization.

- **Transaction History:** Maintain persistent purchase records using Turso.

- **Dashboard:** Monitor spending, pending approvals, and blocked transactions.

##  System Architecture 🏗️

AgentCart uses a full-stack architecture in which the frontend communicates with a backend API that coordinates AI interpretation, product discovery, spending policy enforcement, and payment processing.

### Architecture Components

| Component | Technology | Responsibility |
|---|---|---|
| Frontend | React + Vite | Shopping interface, dashboard, spending rules and approvals |
| Backend | Node.js + Express | API endpoints and purchase orchestration |
| AI Layer | Groq + Gemini | Interpret natural-language shopping requests |
| Product Discovery | Channel3 API | Search and retrieve product information |
| Policy Engine | Custom JavaScript | Evaluate budgets and purchase permissions |
| Payment | PayPal REST API | Create orders and capture payments after buyer authorization |
| Database | Turso | Persist spending rules and transaction records |
| Deployment | Vercel + Render | Host frontend and backend |

### Purchase Workflow

1. The user enters a natural-language shopping request.
2. The AI layer interprets the request and extracts shopping preferences.
3. Channel3 retrieves matching products and offer information.
4. The backend checks product availability, retailer trust and spending rules.
5. AgentCart classifies the purchase:
   - `ALLOWED` — proceed to PayPal checkout.
   - `NEEDS_APPROVAL` — pause checkout and require explicit user approval before creating the PayPal order.
   - `BLOCKED` — prevent the purchase.
6. For approved purchases, the backend creates a PayPal order.
7. The buyer authorizes payment through PayPal.
8. The backend captures the approved payment and records the confirmed transaction in Turso.

**Important:** Spending policies are enforced by the backend, not merely by frontend warnings or AI-generated recommendations.

##  Trust, Security & Approval Design 🔐

AgentCart separates AI recommendations from payment authorization.

- **Backend-enforced policies:** Spending limits are evaluated on the server before a PayPal order can be created.
- **Monthly budget protection:** Completed and pending transactions are considered when evaluating available spending capacity.
- **Explicit purchase approval:** Transactions exceeding the per-transaction limit require a separate approval workflow.
- **Approval expiry:** Purchase approval requests expire after a limited time.
- **Fresh product verification:** Product price, availability and retailer trust are checked again before an approved order is created.
- **Payment verification:** PayPal order status, amount and currency are checked before capture.
- **Transaction integrity:** Purchase records are updated only after PayPal confirms successful capture.

*Note: AgentCart is a hackathon prototype using PayPal Sandbox. It is not a production-ready financial authorization platform.*

##  Getting Started 🚀

### Prerequisites

Make sure you have the following installed:

- Node.js (v20 or later)
- npm
- Git

You will also need API credentials for PayPal Sandbox, Channel3, Groq, and Gemini, along with a Turso database.

### 1. Clone the Repository

```bash
git clone https://github.com/karanthashika/AgentCart.git
cd AgentCart
```

### 2. Configure the Backend

```bash
cd server
npm install
```

Create a `.env` file inside the `server` directory:

```env
PORT=5000
CLIENT_URL=http://localhost:5173

CHANNEL3_API_KEY=your_channel3_api_key

PAYPAL_CLIENT_ID=your_paypal_client_id
PAYPAL_CLIENT_SECRET=your_paypal_client_secret
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com

GROQ_API_KEY=your_groq_api_key
GEMINI_API_KEY=your_gemini_api_key

TURSO_DATABASE_URL=your_turso_database_url
TURSO_AUTH_TOKEN=your_turso_auth_token
```

Replace the placeholder values with your own credentials. Never commit your `.env` file or expose API secrets publicly.

Start the backend:

```bash
node server.js
```

### 3. Configure the Frontend

Open a second terminal:

```bash
cd client
npm install
```

Create a `.env` file inside the `client` directory:

```env
VITE_API_URL=http://localhost:5000
```

Start the frontend:

```bash
npm run dev
```

### 4. Open AgentCart

Visit:

http://localhost:5173

The frontend and backend should both be running.

**Note:** PayPal integration uses Sandbox credentials for testing. No real-money transactions are processed.

## 🌐 Live Demo

- **Application:** https://agentcart-phi.vercel.app/
- **Source Code:** https://github.com/karanthashika/AgentCart

The application uses PayPal Sandbox for payment testing.