services:
  - type: web
    name: vault-backend
    runtime: node
    buildCommand: npm install
    startCommand: node server.js
    envVars:
      - key: PLAID_CLIENT_ID
        value: 69caa7587819c8000da51049
      - key: PLAID_SECRET
        value: 12c30a773261d3d41831d00941a166
      - key: PLAID_ENV
        value: sandbox
      - key: ALPHA_VANTAGE_KEY
        value: OVPMUVP9FPV79597
      - key: GROQ_API_KEY
        value: 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
      - key: JWT_SECRET
        value: vault-jwt-secret-2026-secure
      - key: NODE_ENV
        value: production
