#!/bin/bash
set -e

echo "=== Deploying: Attended Transfer (Line 1/Line 2) ==="

cd /home/rocky/app/cmx_dialer

echo "--- git pull ---"
git pull

echo "--- verifying backend source landed ---"
if ! grep -q "startLineTwo" backend/services/attendedTransferService.js 2>/dev/null; then
  echo "ERROR: attendedTransferService.js missing or doesn't contain startLineTwo. Aborting."
  exit 1
fi
echo "Confirmed: attendedTransferService.js present."

echo "--- restarting backend ---"
pm2 restart cmx-dialer-sandbox
sleep 2
pm2 logs cmx-dialer-sandbox --lines 15 --nostream

echo "--- building frontend ---"
cd frontend
npm run build

echo "--- verifying the new build actually contains the fix ---"
if ! grep -l "Call Line 2" dist/assets/*.js > /dev/null 2>&1; then
  echo "ERROR: 'Call Line 2' not found in the new build. Aborting before copying."
  exit 1
fi
echo "Confirmed: build contains the Line 2 UI text."

echo "--- copying to served directory ---"
sudo cp -r dist/* /var/www/dialer-frontend/

echo "--- verifying the SERVED copy also contains the fix ---"
if ! grep -l "Call Line 2" /var/www/dialer-frontend/assets/*.js > /dev/null 2>&1; then
  echo "ERROR: 'Call Line 2' not found in the served copy after cp. Something went wrong."
  exit 1
fi
echo "Confirmed: served copy contains the Line 2 UI text."

echo "=== Deploy complete. Hard-refresh the browser and test with a REAL call:"
echo "  1. Start Line 2, let it NOT answer -> confirm original call still fine"
echo "  2. Start Line 2, answer, click Cancel -> confirm back with original customer"
echo "  3. Start Line 2, answer, click Transfer -> confirm your leg drops, other two connected"
echo "  4. Start Line 2, answer, click Conference -> confirm all 3 connected, then you hang up, other 2 stay"
echo "==="
