# NovaDeFi Integration Checklist

## Required Environment Variables

### Server (`server/.env`)
- `MONGO_URI`
- `JWT_SECRET`
- `JWT_EXPIRES_IN` (optional, default `7d`)
- `JWT_COOKIE_MAX_AGE_MS` (optional)
- `ADMIN_EMAIL`
- `NODE_ENV`
- `PORT` (optional, default `5000`)

### Client (`client/.env.local`)
- `NEXT_PUBLIC_API_URL` (example: `http://localhost:5000/api`)
- `NEXT_PUBLIC_ADMIN_EMAIL`

## Manual Sanity Checks

1. **Auth**
   - Signup creates account and redirects to dashboard.
   - Login sets session and loads protected pages.
   - Logout clears session and redirects to login.

2. **Dashboard**
   - `/dashboard` loads current user with `/user/me`.
   - Refresh/focus updates balance and profile values.

3. **Deposit**
   - User can submit deposit with valid amount + tx hash.
   - Admin can approve/reject pending deposits.

4. **Withdrawal**
   - User can submit withdrawal with wallet address.
   - Cooldown is enforced by backend and reflected in UI.
   - Admin approve/reject updates status correctly.

5. **Referral**
   - Referral stats load from `/user/referral-stats`.
   - Signup with referral code increases referral counters.
   - Deposit approval triggers multi-level referral earnings.

6. **Admin**
   - Non-admin user cannot access admin APIs.
   - Admin can block/unblock users and reset wallet.
   - Admin stats reflect current system totals.
