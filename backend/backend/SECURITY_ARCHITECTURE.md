# AUTOSHIELD SECURITY SYSTEM MAP
Last Updated: (add today’s date)

=========================================================
CORE ROUTES
=========================================================

/api/security/posture
- Score engine
- Domain calculation
- Tier classification
- Risk classification
- Trend detection
- Volatility
- History recording

/api/security/score-history
- Last 50 score entries

/api/security/events
- SOC event feed

/api/security/tools
- Tool catalog
- Installed state

/api/security/tools/:id/install
/api/security/tools/:id/uninstall
- Tool state toggle

=========================================================
WEBSOCKET FEATURES
=========================================================

/ws/market
- Market data
- Live online user count
- Broadcast online users

=========================================================
FRONTEND COMPONENTS
=========================================================

SecurityRadar.jsx
- Radar visualization
- Executive score header
- Tier + Risk + Trend

SecurityToolMarketplace.jsx
- Tool deployment UI
- Search filter
- Risk labels

LiveOnlineCounter.jsx
- WebSocket live presence
- Online count

=========================================================
STORAGE FILES
=========================================================

/tmp/security_tools.json
- Installed tools state

/tmp/security_score_history.json
- Score history

=========================================================
PENDING FEATURES
=========================================================

[ ] Feature toggle system (admin switchboard)
[ ] Screenshot protection system
[ ] Session timeout system
[ ] Admin-only login portal separation
[ ] Visitor analytics
[ ] Geo location tracking
[ ] Language auto detection
[ ] Currency conversion
[ ] Suspicious activity engine
[ ] Device fingerprinting
[ ] Admin notification center

=========================================================
IMPORTANT NOTES
=========================================================

- Do not duplicate routes.
- Do not create alternate security folders.
- All security logic stays in:
  backend/src/routes/security.routes.js
